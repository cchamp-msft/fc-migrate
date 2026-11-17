/**
 * Opens a G4Session through a CMSIS-DAP v2 probe: the CMSIS-DAP implementation of
 * OpenG4Session. Same connect modes and checks as the ST-Link's.
 */
import { realTime, type TimeSource } from "../swd/time.js";
import type { FlashTimeouts } from "../targets/stm32g4/flash.js";
import { openG4OnProbe } from "../targets/stm32g4/open-on-probe.js";
import type { G4Session, OpenG4Session, OpenOptions, UsbBulkDeviceLike } from "../targets/stm32g4/session.js";
import { CMSIS_DAP_DEFAULT_CLOCK_KHZ } from "./models.js";
import { CmsisDapProbe } from "./probe.js";

/** Extra options for tests. The procedure only needs {@link OpenOptions}. */
export interface CmsisDapOpenOptions extends OpenOptions {
  /** Time source for polling; a simulator under test passes its virtual clock. */
  time?: TimeSource;
  /** Overrides the flash-controller timeouts. */
  timeouts?: Partial<FlashTimeouts>;
  /** Real-time limit for one USB transfer. Default 3 s. */
  transferTimeoutMs?: number;
}

/**
 * Opens the probe, enters SWD and returns a session on the STM32G4. The connect modes
 * are described at {@link openG4OnProbe}.
 *
 * Failures are SessionErrors: "usb" (cannot open or claim the probe, transfer failed),
 * "probe-firmware" (no CMSIS-DAP v2 interface, no SWD, or a refused setting),
 * "no-target" (the chip does not answer SWD), "timeout" (the button was not released
 * in time, or the probe stopped answering).
 */
export const openCmsisDapG4Session = (async (device: UsbBulkDeviceLike, options: CmsisDapOpenOptions): Promise<G4Session> => {
  const time = options.time ?? realTime;
  const probe = await CmsisDapProbe.open(device, {
    clockKhz: options.clockKhz ?? CMSIS_DAP_DEFAULT_CLOCK_KHZ,
    time,
    ...(options.transferTimeoutMs === undefined ? {} : { transferTimeoutMs: options.transferTimeoutMs }),
  });
  return openG4OnProbe(probe, { ...options, time });
}) satisfies OpenG4Session;
