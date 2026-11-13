/**
 * Prints the raw DFU state of a board in the ROM bootloader and tries the non-destructive
 * ways of getting it back to idle. Never erases or writes.
 */
import { WebUSB } from "usb";

const webusb = new WebUSB({ allowAllDevices: true });
const device = (await webusb.getDevices()).find((candidate) => candidate.vendorId === 0x0483 && candidate.productId === 0xdf11);
if (!device) throw new Error("No STM32 DFU device present");

(device as unknown as { device: { timeout: number } }).device.timeout = 8000;
console.log(`Found ${device.productName ?? "?"} configured=${device.configuration?.configurationValue ?? "none"}`);

await device.open();
console.log(`Opened; configuration=${device.configuration?.configurationValue ?? "none"}`);
if (!device.configuration) await device.selectConfiguration(1);
await device.claimInterface(0);
console.log("Claimed interface 0");

const STATES = ["appIDLE", "appDETACH", "dfuIDLE", "DNLOAD-SYNC", "DNBUSY", "DNLOAD-IDLE", "MANIFEST-SYNC", "MANIFEST", "MANIFEST-WAIT", "UPLOAD-IDLE", "dfuERROR"];
const classIn = (request: number, value: number, length: number) => ({ setup: { requestType: "class", recipient: "interface", request, value, index: 0 } as const, length });

async function getStatus(label: string): Promise<number | undefined> {
  try {
    const { setup, length } = classIn(3, 0, 6);
    const result = await device!.controlTransferIn(setup, length);
    if (result.status !== "ok" || !result.data) {
      console.log(`${label}: GETSTATUS transfer status ${result.status}`);
      return undefined;
    }
    const state = result.data.getUint8(4);
    console.log(`${label}: status=${result.data.getUint8(0)} state=${STATES[state] ?? state} poll=${result.data.getUint8(1) | (result.data.getUint8(2) << 8)}ms`);
    return state;
  } catch (error) {
    console.log(`${label}: GETSTATUS threw ${String(error)}`);
    return undefined;
  }
}

async function send(label: string, request: number): Promise<void> {
  try {
    const result = await device!.controlTransferOut({ requestType: "class", recipient: "interface", request, value: 0, index: 0 }, new Uint8Array(0));
    console.log(`${label}: ${result.status}`);
  } catch (error) {
    console.log(`${label}: threw ${String(error)}`);
  }
}

async function descriptor(label: string): Promise<boolean> {
  try {
    const result = await device!.controlTransferIn({ requestType: "standard", recipient: "device", request: 6, value: 0x0200, index: 0 }, 9);
    console.log(`${label}: GET_DESCRIPTOR status=${result.status} bytes=${result.data?.byteLength ?? 0}`);
    return result.status === "ok";
  } catch (error) {
    console.log(`${label}: GET_DESCRIPTOR threw ${String(error)}`);
    return false;
  }
}

await getStatus("initial");
await descriptor("initial");
await getStatus("second read");
await send("ABORT", 6);
await getStatus("after ABORT");
await descriptor("after ABORT");
await send("CLRSTATUS", 4);
await getStatus("after CLRSTATUS");
await descriptor("after CLRSTATUS");

await device.releaseInterface(0).catch(() => undefined);
await device.close().catch(() => undefined);
