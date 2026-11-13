import { openStlinkG4Session, STLINK_USB_FILTERS, type UsbBulkDeviceLike } from "@bf-migrate/core";
import type { ProbeSource } from "../stores/alpha";

export function isWebUsbAvailable(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/** Opens the browser's chooser for an ST-Link. Must be called from a click. */
export async function chooseStlink(): Promise<ProbeSource> {
  const device = await navigator.usb.requestDevice({ filters: [...STLINK_USB_FILTERS] });
  return {
    simulated: false,
    open: (mode, onAttached) => openStlinkG4Session(device as unknown as UsbBulkDeviceLike, { mode, onAttached }),
  };
}
