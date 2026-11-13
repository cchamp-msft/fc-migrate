/**
 * G4Session on top of any debug link: the STM32G4 recipes, the safety checks around
 * them, and the mapping of failures to SessionError kinds. Probe-specific work
 * (opening the probe, re-entering SWD) sits behind {@link DebugLink}.
 */
import type { HexBlock } from "../../firmware/hex.js";
import { haltCore, requestSystemReset, resumeCore, setResetVectorCatch, DHCSR, DHCSR_DBGKEY } from "../../swd/cortex-m.js";
import { MemoryAccessError, hex32, type MemoryAccess } from "../../swd/memory-access.js";
import { pollUntil, type TimeSource } from "../../swd/time.js";
import { DEFAULT_FLASH_TIMEOUTS, erasePages, massErase, pagesTouched, programBlocks, verifyBlocks, type FlashTimeouts } from "./flash.js";
import { readDevId, readFlashSizeKb, readG4 } from "./identify.js";
import { launchOptionBytes, planOptrChange, programOptionBytes, type OptrChange } from "./option-bytes.js";
import { APB1FZR1_DBG_IWDG_STOP, APB1FZR1_DBG_WWDG_STOP, DBGMCU_APB1FZR1, DEV_ID_G47X, FLASH_REG, FLASH_SIZE_KB, OPTR, RDP_LEVEL_0 } from "./registers.js";
import { SessionError, type ByteProgress, type G4Readings, type G4Session, type ProbeInfo, type SessionErrorKind } from "./session.js";

/** What a probe provides to a G4 session. */
export interface DebugLink {
  readonly memory: MemoryAccess;
  readonly probe: ProbeInfo;
  /** Re-enters SWD after the target reset and dropped the debug port. Throws SessionError "no-target" while it cannot. */
  reattach(): Promise<void>;
  /** Releases the probe. Never throws. */
  close(): Promise<void>;
}

export interface SwdG4SessionOptions {
  time: TimeSource;
  /** The connect left the core halted (hold-reset mode). */
  coreHalted: boolean;
  timeouts?: Partial<FlashTimeouts>;
  /** How long to keep trying to re-enter SWD after an option-byte relaunch or reset. */
  reattachTimeoutMs?: number;
}

const HALT_TIMEOUT_MS = 1000;
const DEFAULT_REATTACH_TIMEOUT_MS = 5000;
/** Time for the chip to come back out of the option-byte reset before re-entering SWD. */
const RELAUNCH_SETTLE_MS = 50;

/** Converts any failure into a SessionError. `faultKind` is what a bus fault means in this step. */
export function toSessionError(error: unknown, faultKind: SessionErrorKind): unknown {
  if (error instanceof SessionError) return error;
  if (error instanceof MemoryAccessError) {
    const failure = new SessionError(error.failure === "no-target" ? "no-target" : faultKind, error.message);
    failure.cause = error;
    return failure;
  }
  return error;
}

/** Throws unless FLASH_OPTR shows RDP Level 0. */
function requireLevel0(optr: number): void {
  if ((optr & OPTR.RDP_MASK) !== RDP_LEVEL_0) throw new SessionError("flash", `Read protection is on (FLASH_OPTR ${hex32(optr)}); flash cannot be erased or written.`);
}

export class SwdG4Session implements G4Session {
  private readonly time: TimeSource;
  private readonly timeouts: FlashTimeouts;
  private readonly reattachTimeoutMs: number;
  /** True while the core is halted by this session. */
  private halted: boolean;
  private closed = false;

  constructor(
    private readonly link: DebugLink,
    options: SwdG4SessionOptions,
  ) {
    this.time = options.time;
    this.halted = options.coreHalted;
    this.timeouts = { ...DEFAULT_FLASH_TIMEOUTS, ...options.timeouts };
    this.reattachTimeoutMs = options.reattachTimeoutMs ?? DEFAULT_REATTACH_TIMEOUT_MS;
  }

  get probe(): ProbeInfo {
    return this.link.probe;
  }

  private get memory(): MemoryAccess {
    return this.link.memory;
  }

  async readAll(): Promise<G4Readings> {
    return this.step("no-target", async () => {
      let devId: number | undefined;
      try {
        devId = await readDevId(this.memory);
        return await readG4(this.memory);
      } catch (error) {
        if (devId !== undefined && devId !== DEV_ID_G47X && error instanceof MemoryAccessError && error.failure === "fault") {
          throw new SessionError("wrong-chip", `DEV_ID 0x${devId.toString(16)} is not an STM32G47x/G48x (0x469); reading its registers failed.`);
        }
        throw error;
      }
    });
  }

  async removeReadProtection(options: { clearSwBoot0: boolean }): Promise<void> {
    await this.step("flash", async () => {
      const before = await this.requireKnownChip();
      await this.prepareForChange();
      const atLevel0 = (before & OPTR.RDP_MASK) === RDP_LEVEL_0;
      // Already done, for example by a run that lost its session after OBL_LAUNCH.
      if (atLevel0 && !(options.clearSwBoot0 && (before & OPTR.nSWBOOT0) !== 0)) return;

      const changes: OptrChange[] = atLevel0 ? [] : ["rdp->L0"];
      if (options.clearSwBoot0) changes.push("nSWBOOT0->0");
      await this.applyOptionBytes(before, changes);

      const after = (await this.memory.read32(FLASH_REG.OPTR)) >>> 0;
      if ((after & OPTR.RDP_MASK) !== RDP_LEVEL_0) throw new SessionError("flash", `RDP did not reach Level 0: FLASH_OPTR reads ${hex32(after)} after the relaunch.`);
      if (options.clearSwBoot0 && (after & OPTR.nSWBOOT0) !== 0) throw new SessionError("flash", `nSWBOOT0 is still 1: FLASH_OPTR reads ${hex32(after)}.`);
    });
  }

  async clearSwBoot0(): Promise<void> {
    await this.step("flash", async () => {
      const before = await this.requireKnownChip();
      if ((before & OPTR.RDP_MASK) !== RDP_LEVEL_0) {
        throw new SessionError("flash", `nSWBOOT0 is only changed at RDP Level 0; FLASH_OPTR reads ${hex32(before)}. Remove read protection first.`);
      }
      if ((before & OPTR.nSWBOOT0) === 0) return;
      await this.prepareForChange();
      await this.applyOptionBytes(before, ["nSWBOOT0->0"]);
      const after = (await this.memory.read32(FLASH_REG.OPTR)) >>> 0;
      if ((after & OPTR.nSWBOOT0) !== 0) throw new SessionError("flash", `nSWBOOT0 is still 1: FLASH_OPTR reads ${hex32(after)}.`);
    });
  }

  async erase(blocks: readonly HexBlock[], mode: "pages" | "mass", onProgress?: ByteProgress): Promise<void> {
    await this.step("flash", async () => {
      requireLevel0(await this.requireKnownChip());
      await this.prepareForChange();
      if (mode === "mass") {
        await massErase(this.memory, this.time, this.timeouts, onProgress);
        return;
      }
      await erasePages(this.memory, this.time, pagesTouched(blocks), this.timeouts, onProgress);
    });
  }

  async program(blocks: readonly HexBlock[], onProgress?: ByteProgress): Promise<void> {
    await this.step("flash", async () => {
      requireLevel0(await this.requireKnownChip());
      await this.prepareForChange();
      await programBlocks(this.memory, this.time, blocks, this.timeouts, onProgress);
    });
  }

  async verify(blocks: readonly HexBlock[], onProgress?: ByteProgress): Promise<number | undefined> {
    return this.step("flash", () => verifyBlocks(this.memory, blocks, onProgress));
  }

  async resetAndRun(): Promise<void> {
    await this.step("no-target", async () => {
      await setResetVectorCatch(this.memory, false);
      // Clearing C_DEBUGEN also releases a halt; vector catch needs it, so it cannot re-halt.
      await this.memory.write32(DHCSR, DHCSR_DBGKEY);
      await requestSystemReset(this.memory);
      this.halted = false;
      await this.time.sleep(RELAUNCH_SETTLE_MS);
      try {
        await readDevId(this.memory);
      } catch (error) {
        if (!(error instanceof MemoryAccessError)) throw error;
        // The reset dropped the debug port. Re-attach so reads keep working; if the
        // firmware has taken the SWD pins, later reads report it.
        await this.reattach().catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.halted) {
      // Leave the chip running, as it was found.
      try {
        await setResetVectorCatch(this.memory, false);
        await resumeCore(this.memory);
      } catch {
        // Best effort.
      }
    }
    await this.link.close();
  }

  /** Runs one session step: refuses after close and maps failures to SessionError. */
  private async step<T>(faultKind: SessionErrorKind, task: () => Promise<T>): Promise<T> {
    if (this.closed) throw new SessionError("usb", "The ST-Link session is closed.");
    try {
      return await task();
    } catch (error) {
      throw toSessionError(error, faultKind);
    }
  }

  /**
   * Refuses to change anything unless the chip is, as read now, an STM32G47x/G48x
   * (DEV_ID 0x469) with exactly 512 KB of flash in dual-bank mode. An unreadable flash
   * size is refused too. Nothing is cached: every change re-reads these. Resolves with
   * FLASH_OPTR.
   */
  private async requireKnownChip(): Promise<number> {
    const devId = await readDevId(this.memory);
    if (devId !== DEV_ID_G47X) throw new SessionError("wrong-chip", `DEV_ID 0x${devId.toString(16)} is not an STM32G47x/G48x (0x469). Nothing was changed.`);
    const flashSizeKb = await readFlashSizeKb(this.memory);
    if (flashSizeKb !== FLASH_SIZE_KB) {
      const found = flashSizeKb === undefined ? "an unreadable flash size" : `${flashSizeKb} KB of flash`;
      throw new SessionError("wrong-chip", `This STM32G4 reports ${found}, not ${FLASH_SIZE_KB} KB. Nothing was changed.`);
    }
    const optr = (await this.memory.read32(FLASH_REG.OPTR)) >>> 0;
    if ((optr & OPTR.DBANK) === 0) {
      throw new SessionError("wrong-chip", `The flash is in single-bank mode (DBANK = 0, FLASH_OPTR ${hex32(optr)}), which this procedure does not handle. Nothing was changed.`);
    }
    return optr;
  }

  /**
   * Before any flash or option-byte operation: freeze the watchdogs while halted and
   * halt the core, whichever way the session connected.
   */
  private async prepareForChange(): Promise<void> {
    await this.freezeWatchdogs();
    await this.ensureHalted();
  }

  /** Sets DBGMCU DBG_IWDG_STOP and DBG_WWDG_STOP, so a watchdog cannot reset the chip mid-write. */
  private async freezeWatchdogs(): Promise<void> {
    const bits = (APB1FZR1_DBG_IWDG_STOP | APB1FZR1_DBG_WWDG_STOP) >>> 0;
    const before = await this.memory.read32(DBGMCU_APB1FZR1);
    if ((before & bits) !== bits) await this.memory.write32(DBGMCU_APB1FZR1, (before | bits) >>> 0);
    const after = await this.memory.read32(DBGMCU_APB1FZR1);
    if ((after & bits) !== bits) throw new SessionError("flash", `Could not freeze the watchdogs: DBGMCU_APB1FZR1 reads ${hex32(after)}.`);
  }

  /** Halts the core before flash work, so running firmware cannot touch flash or the SWD pins. */
  private async ensureHalted(): Promise<void> {
    if (this.halted) return;
    if (!(await haltCore(this.memory, this.time, HALT_TIMEOUT_MS))) throw new SessionError("timeout", "The core did not halt.");
    this.halted = true;
  }

  /**
   * Programs the planned option bytes, relaunches them and re-attaches. The relaunch
   * resets the chip, so the halt on the reset vector is armed first: no firmware runs
   * (and takes SWCLK) between the relaunch and the re-attach.
   */
  private async applyOptionBytes(before: number, changes: readonly OptrChange[]): Promise<void> {
    const plan = planOptrChange(before, changes);
    if (plan.changes.length === 0) return;
    await setResetVectorCatch(this.memory, true);
    await programOptionBytes(this.memory, this.time, plan, this.timeouts.optionBytesMs);
    await launchOptionBytes(this.memory);
    this.halted = false;
    await this.time.sleep(RELAUNCH_SETTLE_MS);
    await this.reattach();
    await this.requireKnownChip();
    await this.prepareForChange();
  }

  /** Keeps trying to re-enter SWD until the chip answers or the reattach timeout passes. */
  private async reattach(): Promise<void> {
    let lastError: unknown;
    const ok = await pollUntil(
      this.time,
      this.reattachTimeoutMs,
      async () => {
        try {
          await this.link.reattach();
          return true;
        } catch (error) {
          if (error instanceof SessionError && error.kind === "no-target") {
            lastError = error;
            return false;
          }
          throw error;
        }
      },
      (value) => value,
    );
    if (!ok) throw lastError instanceof SessionError ? lastError : new SessionError("no-target", "The chip did not come back after the reset.");
  }
}
