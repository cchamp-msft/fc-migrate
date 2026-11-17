/**
 * Opens a G4Session through an ST-Link: the ST-Link implementation of OpenG4Session.
 */
import { realTime, type TimeSource } from "../swd/time.js";
import type { FlashTimeouts } from "../targets/stm32g4/flash.js";
import { openG4OnProbe } from "../targets/stm32g4/open-on-probe.js";
import type { G4Session, OpenG4Session, OpenOptions, UsbBulkDeviceLike } from "../targets/stm32g4/session.js";
import { DEFAULT_SWD_CLOCK_KHZ } from "./models.js";
import { StlinkProbe } from "./probe.js";

export { RESET_RELEASE_TIMEOUT_MS } from "../targets/stm32g4/open-on-probe.js";

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
 * Opens the ST-Link, enters SWD and returns a session on the STM32G4. The connect
 * modes are described at {@link openG4OnProbe}.
 *
 * Failures are SessionErrors: "usb" (cannot open or claim the probe, transfer failed),
 * "probe-firmware" (not a V2/V2-1, or firmware older than J22), "no-target" (the chip
 * does not answer SWD), "timeout" (the button was not released in time).
 */
export const openStlinkG4Session = (async (device: UsbBulkDeviceLike, options: StlinkOpenOptions): Promise<G4Session> => {
  const time = options.time ?? realTime;
  const probe = await StlinkProbe.open(device, {
    clockKhz: options.clockKhz ?? DEFAULT_SWD_CLOCK_KHZ,
    time,
    ...(options.transferTimeoutMs === undefined ? {} : { transferTimeoutMs: options.transferTimeoutMs }),
  });
  return openG4OnProbe(probe, { ...options, time });
}) satisfies OpenG4Session;
