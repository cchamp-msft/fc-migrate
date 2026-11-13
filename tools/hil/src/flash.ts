/**
 * Moves a real board through DFU using the same flasher the web app uses.
 *
 *   flash --dump <file>             read the firmware out, then leave DFU unchanged
 *   flash --hex <file>              flash an Intel HEX firmware
 *   flash --restore <file>          write a full flash dump back
 *   --port COM6                     serial port (default COM6)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DfuFlasher, parseIntelHex, type DfuProgress, type HexImage } from "@bf-migrate/core";
import { connect, release } from "./connect.js";
import { waitForDfuDevice } from "./dfu-device.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = option("port") ?? "COM6";
const dumpPath = option("dump");
const hexPath = option("hex");
const restorePath = option("restore");
if (!dumpPath && !hexPath && !restorePath) throw new Error("Pass --dump, --hex or --restore.");

const INTERNAL_FLASH_START = 0x08000000;

let lastPrinted = "";
function progress({ stage, done, total }: DfuProgress): void {
  const percent = total ? Math.floor((done / total) * 10) * 10 : 100;
  const line = `${stage} ${percent}%`;
  if (line !== lastPrinted) {
    lastPrinted = line;
    console.log(`  ${line}`);
  }
}

function loadImage(): HexImage | undefined {
  if (hexPath) return parseIntelHex(readFileSync(resolve(hexPath), "utf8"));
  if (restorePath) {
    const bytes = new Uint8Array(readFileSync(resolve(restorePath)));
    return { data: [{ address: INTERNAL_FLASH_START, bytes }], bytesTotal: bytes.length };
  }
  return undefined;
}

const image = loadImage();
if (image) console.log(`Image: ${image.bytesTotal} bytes in ${image.data.length} block(s)`);

const connection = await connect(port).catch((error: unknown) => {
  console.log(`No firmware answering on ${port} (${String(error)}); looking for a board already in DFU.`);
  return undefined;
});
if (connection) {
  console.log(`Firmware ${connection.identity.firmwareVersion} on ${connection.identity.board.boardName}; rebooting to the bootloader.`);
  await connection.link.rebootToBootloader();
  await release(connection, false);
}

const started = Date.now();
const device = await waitForDfuDevice(90_000, () => console.log(">>> Still waiting for DFU. If nothing changes, RE-PLUG THE BOARD holding the BOOT button."));
console.log(`DFU device found after ${Date.now() - started} ms`);

const flasher = new DfuFlasher(device, progress);
const layout = await flasher.open();
console.log(`Flash: ${layout.flash.name}, ${layout.flash.totalSize} bytes, transfer ${layout.transferSize}`);
console.log(`Sectors: ${layout.flash.sectors.map((sector) => `${sector.pageCount}x${sector.pageSize / 1024}K`).join(" ")}`);

if (dumpPath) {
  const bytes = await flasher.readFlash(layout.flash.startAddress, layout.flash.totalSize);
  writeFileSync(resolve(dumpPath), bytes);
  console.log(`Saved ${bytes.length} bytes to ${resolve(dumpPath)}, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
}

if (image) {
  await flasher.flash(image);
  console.log("Flash written and verified. Leaving DFU.");
} else {
  await flasher.leave();
  console.log("Left DFU without changes.");
}

const rebootStarted = Date.now();
await new Promise((done) => setTimeout(done, 1500));
const after = await connect(port, 25_000);
console.log(`Back up after ${Date.now() - rebootStarted} ms: ${after.identity.variant} ${after.identity.firmwareVersion}, build key ${after.identity.buildKey ?? "none"}`);
await release(after, false);
