/**
 * Writes a firmware hex to an STM32G4 at RDP Level 0 through an ST-Link, with the same
 * session code the web app uses: erase the pages the image touches (the settings area
 * stays unless the image covers it), program, verify, reset and run. Never changes
 * option bytes or read protection. Without --yes it only reads the chip and plans.
 *
 *   stlink-write --hex firmware.hex [--clear <start>-<end>]... [--yes]
 *
 * --clear also erases the pages of an address range the image leaves alone, for
 * example leftovers from an earlier image.
 */
import { readFileSync } from "node:fs";
import { WebUSB } from "usb";
import { openStlinkG4Session, parseIntelHex, STLINK_USB_FILTERS, type HexBlock, type UsbBulkDeviceLike } from "@bf-migrate/core";

const hex = (value: number): string => `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
const args = process.argv.slice(2);
const hexPath = args[args.indexOf("--hex") + 1];
if (!args.includes("--hex") || !hexPath) {
  console.error("usage: stlink-write --hex firmware.hex [--clear <start>-<end>]... [--yes]");
  process.exit(1);
}
const clears: HexBlock[] = [];
args.forEach((arg, index) => {
  if (arg !== "--clear") return;
  const [start, end] = (args[index + 1] ?? "").split("-").map((part) => Number(part));
  if (!Number.isInteger(start) || !Number.isInteger(end) || end! <= start!) throw new Error(`Bad --clear range: ${args[index + 1]}`);
  clears.push({ address: start!, bytes: new Uint8Array(end! - start!).fill(0xff) });
});

const image = parseIntelHex(readFileSync(hexPath, "utf8"));
for (const block of image.data) console.log(`Image block ${hex(block.address)} +${block.bytes.length}`);
for (const block of clears) console.log(`Also erase  ${hex(block.address)} +${block.bytes.length}`);

const webusb = new WebUSB({ allowAllDevices: true });
const device = (await webusb.getDevices()).find((candidate) => STLINK_USB_FILTERS.some((filter) => filter.vendorId === candidate.vendorId && filter.productId === candidate.productId));
if (!device) {
  console.error("No ST-Link found.");
  process.exit(1);
}

const session = await openStlinkG4Session(device as unknown as UsbBulkDeviceLike, { mode: "hotplug" });
try {
  const readings = await session.readAll();
  console.log(`DEV_ID ${hex(readings.devId)}, ${readings.flashSizeKb} KB, FLASH_OPTR ${hex(readings.optr)}`);
  if (!args.includes("--yes")) {
    console.log("Plan only. Pass --yes to erase, write and verify.");
  } else {
    let last = -1;
    const progress = (label: string) => (done: number, total: number) => {
      const percent = Math.floor((done / total) * 100);
      if (percent >= last + 20 || done === total) {
        console.log(`${label} ${percent}%`);
        last = percent;
      }
    };
    last = -1;
    await session.erase([...image.data, ...clears], "pages", progress("Erase"));
    last = -1;
    await session.program(image.data, progress("Write"));
    last = -1;
    const mismatch = await session.verify(image.data, progress("Verify"));
    if (mismatch !== undefined) throw new Error(`Verify failed at ${hex(mismatch)}`);
    console.log("Verified. Resetting.");
    await session.resetAndRun();
    console.log("Running.");
  }
} finally {
  await session.close();
}
