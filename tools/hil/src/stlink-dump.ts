/**
 * Read-only: attaches to a running STM32G4 through an ST-Link without reset or halt,
 * reports what the core is doing (fault and exception state, sampled PC), dumps the
 * whole flash to a file and, given a hex, compares it. Never writes flash or resets.
 *
 *   stlink-dump --out flash.bin [--hex firmware.hex] [--clock <kHz>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { WebUSB } from "usb";
import { parseIntelHex, StlinkProbe, STLINK_USB_FILTERS, type UsbBulkDeviceLike } from "@bf-migrate/core";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const FLASH_START = 0x08000000;
const FLASH_SIZE = 512 * 1024;
const hex = (value: number): string => `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

const out = option("out");
const hexPath = option("hex");
if (!out) {
  console.error("usage: stlink-dump --out flash.bin [--hex firmware.hex]");
  process.exit(1);
}

const webusb = new WebUSB({ allowAllDevices: true });
const device = (await webusb.getDevices()).find((candidate) => STLINK_USB_FILTERS.some((filter) => filter.vendorId === candidate.vendorId && filter.productId === candidate.productId));
if (!device) {
  console.error("No ST-Link found.");
  process.exit(1);
}

const probe = await StlinkProbe.open(device as unknown as UsbBulkDeviceLike, { clockKhz: Number(option("clock") ?? 480) });
try {
  await probe.enterSwd();
  const registers: [string, number][] = [
    ["DHCSR", 0xe000edf0],
    ["ICSR", 0xe000ed04],
    ["VTOR", 0xe000ed08],
    ["CFSR", 0xe000ed28],
    ["HFSR", 0xe000ed2c],
    ["MMFAR", 0xe000ed34],
    ["BFAR", 0xe000ed38],
    ["RCC_CSR", 0x40021094],
  ];
  for (const [name, address] of registers) console.log(`${name.padEnd(8)} ${hex(await probe.read32(address))}`);
  const samples: string[] = [];
  for (let i = 0; i < 8; i++) samples.push(hex(await probe.read32(0xe000101c)));
  console.log(`PCSR     ${samples.join(" ")}`);

  const started = Date.now();
  const flash = await probe.readBlock(FLASH_START, FLASH_SIZE);
  writeFileSync(out, flash);
  console.log(`Dumped ${FLASH_SIZE} bytes to ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  if (hexPath) {
    const image = parseIntelHex(readFileSync(hexPath, "utf8"));
    for (const block of image.data) {
      const offset = block.address - FLASH_START;
      let differing = 0;
      let first: number | undefined;
      let erased = 0;
      for (let i = 0; i < block.bytes.length; i++) {
        const actual = flash[offset + i];
        if (actual === 0xff) erased++;
        if (actual !== block.bytes[i]) {
          differing++;
          first ??= block.address + i;
        }
      }
      console.log(
        `Block ${hex(block.address)} +${block.bytes.length}: ${differing === 0 ? "matches" : `${differing} bytes differ, first at ${hex(first!)}`}; ${erased} bytes read 0xFF`,
      );
    }
  }
} finally {
  await probe.close();
}
