/** Attempts a USB-level reset of a wedged ROM bootloader. Does not touch flash. */
import { WebUSB } from "usb";
const webusb = new WebUSB({ allowAllDevices: true });
const device = (await webusb.getDevices()).find((candidate) => candidate.vendorId === 0x0483 && candidate.productId === 0xdf11);
if (!device) throw new Error("No STM32 DFU device present");
await device.open();
try {
  await device.reset();
  console.log("USB reset completed");
} catch (error) {
  console.log(`USB reset failed: ${String(error)}`);
}
await device.close().catch(() => undefined);
