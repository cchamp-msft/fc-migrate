import { CMSIS_DAP_USB_FILTERS, openCmsisDapG4Session, openStlinkG4Session, STLINK_USB_FILTERS, stlinkModelFor, type UsbBulkDeviceLike } from "@bf-migrate/core";
import type { ProbeSource } from "../stores/alpha";

export function isWebUsbAvailable(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/**
 * Opens the browser's chooser for an SWD probe: an ST-Link, or a CMSIS-DAP probe such as
 * a Flipper Zero running DAP Link. An ST-Link's USB IDs pick the ST-Link session;
 * anything else is opened as CMSIS-DAP, which refuses a device with no CMSIS-DAP
 * interface. Must be called from a click.
 */
export async function chooseProbe(): Promise<ProbeSource> {
  const device = await navigator.usb.requestDevice({ filters: [...STLINK_USB_FILTERS, ...CMSIS_DAP_USB_FILTERS] });
  const usb = device as unknown as UsbBulkDeviceLike;
  const open = stlinkModelFor(device.vendorId, device.productId) ? openStlinkG4Session : openCmsisDapG4Session;
  return {
    simulated: false,
    open: (mode, onAttached) => open(usb, { mode, onAttached }),
  };
}
