import { WebUSB } from "usb";
import type { UsbDeviceLike } from "@bf-migrate/core";

const STM32_DFU = { vendorId: 0x0483, productId: 0xdf11 };
const POLL_MS = 300;
const CONTROL_TIMEOUT_MS = 8000;

const webusb = new WebUSB({ allowAllDevices: true });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for a board in the STM32 ROM bootloader. */
export async function waitForDfuDevice(timeoutMs: number, onSlow?: () => void): Promise<UsbDeviceLike> {
  const started = Date.now();
  let warned = false;
  for (;;) {
    const devices = await webusb.getDevices();
    const device = devices.find((candidate) => candidate.vendorId === STM32_DFU.vendorId && candidate.productId === STM32_DFU.productId);
    if (device) {
      // node-usb gives control transfers one second by default, but the ROM holds the
      // status request until a sector erase finishes. A 128K sector can take longer.
      (device as unknown as { device: { timeout: number } }).device.timeout = CONTROL_TIMEOUT_MS;
      return device as unknown as UsbDeviceLike;
    }
    const elapsed = Date.now() - started;
    if (!warned && elapsed > 6000) {
      warned = true;
      onSlow?.();
    }
    if (elapsed > timeoutMs) throw new Error("No STM32 DFU device appeared.");
    await sleep(POLL_MS);
  }
}
