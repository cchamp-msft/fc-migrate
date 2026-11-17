/**
 * The CMSIS-DAP probes the browser's chooser lists. Any probe with a CMSIS-DAP v2
 * (bulk) interface works once chosen; the chooser needs USB IDs to filter on, so only
 * these are offered.
 */
import { DEFAULT_SWD_CLOCK_KHZ } from "../stlink/models.js";

export interface CmsisDapModel {
  name: string;
  vendorId: number;
  productId: number;
}

export const CMSIS_DAP_MODELS: readonly CmsisDapModel[] = [
  /**
   * The Flipper Zero's DAP Link app. It reuses ST's virtual COM port IDs, which most
   * STM32 USB serial devices share, flight controllers included, so the chooser can
   * list those too. Choosing one fails cleanly: it has no CMSIS-DAP interface.
   */
  { name: "Flipper Zero (DAP Link app)", vendorId: 0x0483, productId: 0x5740 },
  /** The Raspberry Pi Debug Probe, and a Pico running Raspberry Pi's debugprobe firmware. */
  { name: "Raspberry Pi debugprobe", vendorId: 0x2e8a, productId: 0x000c },
];

/** USB IDs for the browser's device chooser. */
export const CMSIS_DAP_USB_FILTERS: readonly { vendorId: number; productId: number }[] = CMSIS_DAP_MODELS.map(({ vendorId, productId }) => ({ vendorId, productId }));

/** Default SWD clock: the same as the ST-Link's. The Flipper Zero conversion ran at this rate. */
export const CMSIS_DAP_DEFAULT_CLOCK_KHZ = DEFAULT_SWD_CLOCK_KHZ;
