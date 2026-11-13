/**
 * Opens a G4Session through an ST-Link: the ST-Link implementation of OpenG4Session.
 */
import { haltThroughResetHold } from "../swd/cortex-m.js";
import { realTime, type TimeSource } from "../swd/time.js";
import { readDevId } from "../targets/stm32g4/identify.js";
import { SessionError, type G4Session, type OpenG4Session, type OpenOptions, type UsbBulkDeviceLike } from "../targets/stm32g4/session.js";
import { SwdG4Session, toSessionError, type DebugLink } from "../targets/stm32g4/swd-session.js";
import type { FlashTimeouts } from "../targets/stm32g4/flash.js";
import { DEFAULT_SWD_CLOCK_KHZ } from "./models.js";
import { StlinkProbe } from "./probe.js";

/** How long the user has to release the reset button after the app says so. */
export const RESET_RELEASE_TIMEOUT_MS = 30_000;
/** How long to keep trying to arm the reset catch while the button is held. */
const ARM_TIMEOUT_MS = 3_000;

/** Extra options for tests and the demo. The procedure only needs {@link OpenOptions}. */
export interface StlinkOpenOptions extends OpenOptions {
  /** Time source for polling; a simulator under test passes its virtual clock. */
  time?: TimeSource;
  /** Overrides the flash-controller timeouts. */
  timeouts?: Partial<FlashTimeouts>;
  /** Real-time limit for one USB transfer. Default 3 s. */
  transferTimeoutMs?: number;
}

/**
 * Opens the ST-Link, enters SWD and returns a session on the STM32G4.
 *
 * `hotplug` attaches to the running chip without resetting or halting it. `holdReset`
 * expects the user to be holding the board's reset button: it attaches while the chip
 * is in reset, arms a halt on the reset vector, calls `onAttached` once, then waits up
 * to 30 s for the core to halt, which happens when the button is released. The
 * probe's RST pin is never used.
 *
 * Failures are SessionErrors: "usb" (cannot open or claim the probe, transfer failed),
 * "probe-firmware" (not a V2/V2-1, or firmware older than J22), "no-target" (the chip
 * does not answer SWD), "timeout" (the button was not released in time).
 * A chip that answers but is not an STM32G4 still opens: readAll reports its DEV_ID
 * and every method that changes the chip throws "wrong-chip".
 */
export const openStlinkG4Session = (async (device: UsbBulkDeviceLike, options: StlinkOpenOptions): Promise<G4Session> => {
  const time = options.time ?? realTime;
  const probe = await StlinkProbe.open(device, {
    clockKhz: options.clockKhz ?? DEFAULT_SWD_CLOCK_KHZ,
    time,
    ...(options.transferTimeoutMs === undefined ? {} : { transferTimeoutMs: options.transferTimeoutMs }),
  });
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
    return new SwdG4Session(link, { time, coreHalted, ...(options.timeouts ? { timeouts: options.timeouts } : {}) });
  } catch (error) {
    await probe.close();
    throw toSessionError(error, "no-target");
  }
}) satisfies OpenG4Session;
