/**
 * FLASH_OPTR decoding and the only option-byte changes Alpha Migrate makes: RDP to
 * Level 0, and nSWBOOT0 to 0. Level 2 (RDP 0xCC) is permanent and must never be
 * written; {@link planOptrChange} is the single place an OPTR value to write is made,
 * and it refuses anything but those two changes.
 */
import type { MemoryAccess } from "../../swd/memory-access.js";
import { hex32 } from "../../swd/memory-access.js";
import type { TimeSource } from "../../swd/time.js";
import { checkFlashErrors, clearFlashErrors, lockFlash, unlockFlash, unlockOptionBytes, waitFlashIdle } from "./flash.js";
import { CR, FLASH_REG, OPTR, RDP_LEVEL_0, RDP_LEVEL_2 } from "./registers.js";
import { SessionError } from "./session.js";

export type RdpLevel = 0 | 1 | 2;

/** RDP 0xAA is Level 0, 0xCC is Level 2, anything else is Level 1 (stm32g4xx_hal_flash.h:254-256). */
export function rdpLevelOf(rdp: number): RdpLevel {
  const value = rdp & OPTR.RDP_MASK;
  if (value === RDP_LEVEL_0) return 0;
  if (value === RDP_LEVEL_2) return 2;
  return 1;
}

export interface DecodedOptr {
  raw: number;
  rdp: number;
  rdpLevel: RdpLevel;
  /** BOR_LEV, bits 10:8. */
  borLevel: number;
  /** DBANK: dual-bank mode with 2 KB pages. */
  dualBank: boolean;
  bfb2: boolean;
  nBoot1: boolean;
  /** nSWBOOT0 = 1: the BOOT0 pin decides; 0: nBOOT0 decides. */
  nSwBoot0: boolean;
  nBoot0: boolean;
  /** True when the BOOT0 pin is honoured at reset (nSWBOOT0 = 1). */
  boot0PinHonoured: boolean;
}

/** Splits FLASH_OPTR into the fields the procedure reports. Pure. */
export function decodeOptr(optr: number): DecodedOptr {
  const raw = optr >>> 0;
  const rdp = raw & OPTR.RDP_MASK;
  const nSwBoot0 = (raw & OPTR.nSWBOOT0) !== 0;
  return {
    raw,
    rdp,
    rdpLevel: rdpLevelOf(rdp),
    borLevel: (raw >>> 8) & 0x7,
    dualBank: (raw & OPTR.DBANK) !== 0,
    bfb2: (raw & OPTR.BFB2) !== 0,
    nBoot1: (raw & OPTR.nBOOT1) !== 0,
    nSwBoot0,
    nBoot0: (raw & OPTR.nBOOT0) !== 0,
    boot0PinHonoured: nSwBoot0,
  };
}

/** The only two option-byte changes this code can make. */
export type OptrChange = "rdp->L0" | "nSWBOOT0->0";

export interface OptrPlan {
  before: number;
  after: number;
  /** The requested changes that alter at least one bit. Empty when `after === before`. */
  changes: OptrChange[];
}

/** A refused option-byte plan. Always a programming error; never retry it. */
export class OptrPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptrPlanError";
  }
}

const CHANGE_MASK = (OPTR.RDP_MASK | OPTR.nSWBOOT0) >>> 0;

/**
 * Works out the OPTR value to write for the requested changes. Pure and guarded:
 * - `rdp->L0` sets RDP to 0xAA; `nSWBOOT0->0` clears bit 26. Nothing else is accepted.
 * - Every other bit of `before` is kept.
 * - Throws on an unknown change, a malformed `before`, a chip already at Level 2, or
 *   any result that would hold RDP 0xCC.
 */
export function planOptrChange(before: number, requested: readonly OptrChange[]): OptrPlan {
  if (!Number.isInteger(before) || before < 0 || before > 0xffffffff) throw new OptrPlanError(`OPTR ${String(before)} is not a 32-bit value`);
  if (requested.length === 0) throw new OptrPlanError("No option-byte change requested");
  if (rdpLevelOf(before) === 2) throw new OptrPlanError("The chip is at RDP Level 2; its option bytes can never change");

  let after = before >>> 0;
  for (const change of requested) {
    if (change === "rdp->L0") after = ((after & ~OPTR.RDP_MASK) | RDP_LEVEL_0) >>> 0;
    else if (change === "nSWBOOT0->0") after = (after & ~OPTR.nSWBOOT0) >>> 0;
    else throw new OptrPlanError(`Refusing option-byte change ${JSON.stringify(change)}`);
  }

  // Independent re-checks of the result, so a future edit above cannot slip through.
  if (((after ^ before) & ~CHANGE_MASK) !== 0) throw new OptrPlanError(`Plan ${hex32(before)} -> ${hex32(after)} touches bits outside RDP and nSWBOOT0`);
  const rdpAfter = after & OPTR.RDP_MASK;
  if (rdpAfter === RDP_LEVEL_2) throw new OptrPlanError("Refusing to write RDP Level 2");
  if (rdpAfter !== RDP_LEVEL_0 && rdpAfter !== (before & OPTR.RDP_MASK)) throw new OptrPlanError(`Refusing RDP 0x${rdpAfter.toString(16)}`);
  if ((after & OPTR.nSWBOOT0) !== 0 && (before & OPTR.nSWBOOT0) === 0) throw new OptrPlanError("Refusing to set nSWBOOT0");

  const changes: OptrChange[] = [];
  if ((after & OPTR.RDP_MASK) !== (before & OPTR.RDP_MASK)) changes.push("rdp->L0");
  if ((after & OPTR.nSWBOOT0) !== (before & OPTR.nSWBOOT0)) changes.push("nSWBOOT0->0");
  return { before: before >>> 0, after, changes };
}

/** Re-derives a plan from its own `before` and `changes` and checks `after` matches. */
function verifyPlan(plan: OptrPlan): void {
  if (plan.changes.length === 0) throw new OptrPlanError("Empty option-byte plan");
  const again = planOptrChange(plan.before, plan.changes);
  if (again.after !== plan.after) throw new OptrPlanError(`Option-byte plan was altered: ${hex32(plan.after)}, expected ${hex32(again.after)}`);
}

/**
 * Writes a planned OPTR value and programs it (OPTSTRT), waiting for the flash
 * controller. RDP regression mass-erases the chip during this wait, so `timeoutMs`
 * must be generous. Does not relaunch the option bytes; see {@link launchOptionBytes}.
 * On success FLASH_CR and the option bytes stay unlocked for the relaunch; on any
 * failure both are locked again.
 */
export async function programOptionBytes(memory: MemoryAccess, time: TimeSource, plan: OptrPlan, timeoutMs: number): Promise<void> {
  verifyPlan(plan);
  const current = (await memory.read32(FLASH_REG.OPTR)) >>> 0;
  if (current !== plan.before) throw new SessionError("flash", `FLASH_OPTR reads ${hex32(current)}, not ${hex32(plan.before)}; nothing was written.`);

  try {
    await unlockFlash(memory);
    await unlockOptionBytes(memory);
    await waitFlashIdle(memory, time, timeoutMs, "the option-byte write");
    await clearFlashErrors(memory);

    // Last line of defence at the only OPTR write site.
    if ((plan.after & OPTR.RDP_MASK) === RDP_LEVEL_2) throw new OptrPlanError("Refusing to write RDP Level 2");
    await memory.write32(FLASH_REG.OPTR, plan.after);
    const cr = await memory.read32(FLASH_REG.CR);
    await memory.write32(FLASH_REG.CR, (cr | CR.OPTSTRT) >>> 0);
    const sr = await waitFlashIdle(memory, time, timeoutMs, "option-byte programming");
    checkFlashErrors(sr, "Option-byte programming");
  } catch (error) {
    // On success the locks must stay open for OBL_LAUNCH; on any failure, close both.
    await lockFlash(memory).catch(() => undefined);
    throw error;
  }
}

/**
 * Sets OBL_LAUNCH so the new option bytes take effect. The chip resets and the debug
 * port drops, so failures of this write are expected and ignored. Leaves the flash
 * locked if the chip did not reset.
 */
export async function launchOptionBytes(memory: MemoryAccess): Promise<void> {
  try {
    const cr = await memory.read32(FLASH_REG.CR);
    await memory.write32(FLASH_REG.CR, (cr | CR.OBL_LAUNCH) >>> 0);
  } catch (error) {
    if (error instanceof SessionError) throw error;
  }
  await lockFlash(memory).catch(() => undefined);
}
