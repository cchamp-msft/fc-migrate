/**
 * A stand-in firmware file for the Alpha Migrate demo. It is laid out like Betaflight's
 * G474 build (code from 0x08000000, the settings area at 0x08004000 left alone, more
 * code from 0x08006000) and carries the strings the image check looks for. It does
 * not run on anything: its handlers point at text. It carries DEMO_IMAGE_MARKER, so the
 * image check refuses it for anything but the simulated board.
 */
import { DEMO_IMAGE_MARKER } from "@bf-migrate/core";

function record(type: number, address: number, data: readonly number[]): string {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  const checksum = (0x100 - (bytes.reduce((sum, byte) => sum + byte, 0) & 0xff)) & 0xff;
  return `:${[...bytes, checksum].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

/** Encodes blocks as Intel HEX, 16 data bytes per record. */
export function toIntelHex(blocks: readonly { address: number; bytes: Uint8Array }[]): string {
  const lines: string[] = [];
  let upper = -1;
  for (const block of blocks) {
    for (let offset = 0; offset < block.bytes.length; offset += 16) {
      const address = block.address + offset;
      if (address >>> 16 !== upper) {
        upper = address >>> 16;
        lines.push(record(0x04, 0, [(upper >> 8) & 0xff, upper & 0xff]));
      }
      lines.push(record(0x00, address & 0xffff, [...block.bytes.subarray(offset, offset + 16)]));
    }
  }
  lines.push(record(0x01, 0, []));
  return `${lines.join("\n")}\n`;
}

export function demoAlphaFirmware(): { name: string; text: string } {
  const code = new Uint8Array(0x2800);
  const view = new DataView(code.buffer);
  view.setUint32(0, 0x20020000, true); // initial stack pointer, the top of SRAM
  // Reset, NMI and HardFault, as Thumb addresses inside the image: the shape the check asks for.
  for (const offset of [4, 8, 12]) view.setUint32(offset, 0x08000201, true);
  code.set(new TextEncoder().encode(["Betaflight", "BTFL", "TMOTORG4ALPHAHD", "COMM", "2026.6.2 (demo)", DEMO_IMAGE_MARKER, ""].join("\u0000")), 0x200);

  // Deterministic filler, so every demo run writes the same bytes.
  const more = new Uint8Array(0x14000);
  let seed = 0x2026;
  for (let i = 0; i < more.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    more[i] = seed >>> 24;
  }
  return { name: "betaflight_2026.6.2_TMOTORG4ALPHAHD_demo.hex", text: toIntelHex([{ address: 0x08000000, bytes: code }, { address: 0x08006000, bytes: more }]) };
}
