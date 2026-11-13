/**
 * Cortex-M core control through the standard ARMv7-M debug registers. These are plain
 * memory accesses on the System Control Space, so they work through any MemoryAccess.
 */
import { MemoryAccessError, type MemoryAccess } from "./memory-access.js";
import { pollUntil, type TimeSource } from "./time.js";

/** Debug Halting Control and Status Register. */
export const DHCSR = 0xe000edf0;
/** Debug Exception and Monitor Control Register. */
export const DEMCR = 0xe000edfc;
/** Application Interrupt and Reset Control Register. */
export const AIRCR = 0xe000ed0c;

/** DHCSR writes are ignored unless the upper half holds this key. */
export const DHCSR_DBGKEY = 0xa05f0000;
export const DHCSR_C_DEBUGEN = 1 << 0;
export const DHCSR_C_HALT = 1 << 1;
export const DHCSR_S_HALT = 1 << 17;
/** Sticky: the core has been reset since DHCSR was last read. */
export const DHCSR_S_RESET_ST = 1 << 25;

/** DEMCR bit 0: halt on the reset vector. */
export const DEMCR_VC_CORERESET = 1 << 0;

export const AIRCR_VECTKEY = 0x05fa0000;
export const AIRCR_SYSRESETREQ = 1 << 2;

export async function isHalted(memory: MemoryAccess): Promise<boolean> {
  return ((await memory.read32(DHCSR)) & DHCSR_S_HALT) !== 0;
}

/** Requests a halt and waits for it. Resolves false when the core did not halt in time. */
export async function haltCore(memory: MemoryAccess, time: TimeSource, timeoutMs = 1000): Promise<boolean> {
  await memory.write32(DHCSR, (DHCSR_DBGKEY | DHCSR_C_DEBUGEN | DHCSR_C_HALT) >>> 0);
  return (await pollUntil(time, timeoutMs, () => isHalted(memory), (halted) => halted)) === true;
}

/** Lets a halted core run, leaving debug enabled. */
export async function resumeCore(memory: MemoryAccess): Promise<void> {
  await memory.write32(DHCSR, (DHCSR_DBGKEY | DHCSR_C_DEBUGEN) >>> 0);
}

/** Turns the halt on the reset vector on or off. */
export async function setResetVectorCatch(memory: MemoryAccess, enabled: boolean): Promise<void> {
  const demcr = await memory.read32(DEMCR);
  const next = enabled ? demcr | DEMCR_VC_CORERESET : demcr & ~DEMCR_VC_CORERESET;
  if (next !== demcr) await memory.write32(DEMCR, next >>> 0);
}

/**
 * Asks for a system reset through AIRCR. The chip resets while the write completes, so
 * a fault on the write itself is expected and ignored. A lost debug port is not.
 */
export async function requestSystemReset(memory: MemoryAccess): Promise<void> {
  try {
    await memory.write32(AIRCR, (AIRCR_VECTKEY | AIRCR_SYSRESETREQ) >>> 0);
  } catch (error) {
    if (!(error instanceof MemoryAccessError && error.failure === "fault")) throw error;
  }
}

export interface ResetHoldOptions {
  /** How long to keep trying to arm the catch while the chip is in reset. */
  armTimeoutMs: number;
  /** How long to wait for the user to release the button. */
  releaseTimeoutMs: number;
  /** Called once the catch is armed, while the chip is still held in reset. */
  onArmed?: () => void;
}

export type ResetHoldResult = "halted" | "not-armed" | "not-released";

/**
 * Connect-under-reset driven by the user's reset button instead of the probe's RST pin.
 * The chip is held in reset by the button. This enables debug, sets VC_CORERESET and
 * requests a halt, then waits for the core to report halted, which happens on the reset
 * vector once the button is released, before the firmware can claim the SWD pins.
 *
 * Bus faults while the chip is in reset are retried; a lost debug port is thrown.
 */
export async function haltThroughResetHold(memory: MemoryAccess, time: TimeSource, options: ResetHoldOptions): Promise<ResetHoldResult> {
  const armed = await pollUntil(
    time,
    options.armTimeoutMs,
    async () => {
      try {
        await memory.write32(DHCSR, (DHCSR_DBGKEY | DHCSR_C_DEBUGEN | DHCSR_C_HALT) >>> 0);
        await setResetVectorCatch(memory, true);
        return true;
      } catch (error) {
        if (error instanceof MemoryAccessError && error.failure === "fault") return false;
        throw error;
      }
    },
    (ok) => ok,
  );
  if (!armed) return "not-armed";

  options.onArmed?.();

  const halted = await pollUntil(
    time,
    options.releaseTimeoutMs,
    async () => {
      try {
        return await isHalted(memory);
      } catch (error) {
        if (error instanceof MemoryAccessError && error.failure === "fault") return false;
        throw error;
      }
    },
    (value) => value,
  );
  return halted ? "halted" : "not-released";
}
