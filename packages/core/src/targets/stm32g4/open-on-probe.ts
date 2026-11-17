/**
 * The probe-independent half of opening a G4Session: attach to the chip (hot-plug, or
 * through the pilot's reset button), prove the bus behind the debug port works, and
 * wrap the probe in a SwdG4Session. Each probe layer opens its USB device and passes
 * an {@link SwdProbe} here.
 */
import { haltThroughResetHold } from "../../swd/cortex-m.js";
import type { MemoryAccess } from "../../swd/memory-access.js";
import type { TimeSource } from "../../swd/time.js";
import type { FlashTimeouts } from "./flash.js";
import { readDevId } from "./identify.js";
import { SessionError, type G4Session, type OpenOptions, type ProbeInfo } from "./session.js";
import { SwdG4Session, toSessionError, type DebugLink } from "./swd-session.js";

/** How long the user has to release the reset button after the app says so. */
export const RESET_RELEASE_TIMEOUT_MS = 30_000;
/** How long to keep trying to arm the reset catch while the button is held. */
const ARM_TIMEOUT_MS = 3_000;

/** An open probe with SWD memory access to the target. */
export interface SwdProbe extends MemoryAccess {
  readonly info: ProbeInfo;
  /** Starts SWD and reads the debug port's IDCODE. Throws SessionError "no-target" when the chip does not answer. */
  enterSwd(): Promise<number>;
  /** Re-enters SWD after the target reset and the debug port dropped. */
  reattach(): Promise<void>;
  /** Releases the probe. Never throws. */
  close(): Promise<void>;
}

/** What {@link openG4OnProbe} needs beyond {@link OpenOptions}. */
export interface ProbeSessionOptions extends OpenOptions {
  time: TimeSource;
  timeouts?: Partial<FlashTimeouts>;
}

/**
 * Enters SWD and returns a session on the STM32G4.
 *
 * `hotplug` attaches to the running chip without resetting or halting it. `holdReset`
 * expects the user to be holding the board's reset button: it attaches while the chip
 * is in reset, arms a halt on the reset vector, calls `onAttached` once, then waits up
 * to 30 s for the core to halt, which happens when the button is released. The
 * probe's reset pin is never used.
 *
 * Closes the probe on failure. Failures are SessionErrors: "no-target" (the chip does
 * not answer SWD) and "timeout" (the button was not released in time), plus whatever
 * the probe reports. A chip that answers but is not an STM32G4 still opens: readAll
 * reports its DEV_ID and every method that changes the chip throws "wrong-chip".
 */
export async function openG4OnProbe(probe: SwdProbe, options: ProbeSessionOptions): Promise<G4Session> {
  const { time } = options;
  try {
    await probe.enterSwd();

    let coreHalted = false;
    if (options.mode === "holdReset") {
      const result = await haltThroughResetHold(probe, time, {
        armTimeoutMs: ARM_TIMEOUT_MS,
        releaseTimeoutMs: RESET_RELEASE_TIMEOUT_MS,
        ...(options.onAttached ? { onArmed: options.onAttached } : {}),
      });
      if (result === "not-armed") throw new SessionError("no-target", "SWD attached, but the core's debug registers did not respond while in reset.");
      if (result === "not-released") {
        throw new SessionError("timeout", `The core did not halt within ${RESET_RELEASE_TIMEOUT_MS / 1000} s. Release the reset button when the app asks you to.`);
      }
      coreHalted = true;
    }

    // Proves the bus behind the debug port works, not only the port itself.
    await readDevId(probe);

    const link: DebugLink = {
      memory: probe,
      get probe() {
        return probe.info;
      },
      reattach: () => probe.reattach(),
      close: () => probe.close(),
    };
    return new SwdG4Session(link, { time, coreHalted, allowDemoImage: options.allowDemoImage === true, ...(options.timeouts ? { timeouts: options.timeouts } : {}) });
  } catch (error) {
    await probe.close();
    throw toSessionError(error, "no-target");
  }
}
