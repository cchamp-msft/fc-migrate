/** Prints what a read-only G4 session found, for the harness's read-only probe scripts. */
import type { G4Readings } from "@bf-migrate/core";

const hex = (value: number, digits = 8): string => `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, "0")}`;

function describeOptr(optr: number): string {
  const rdp = optr & 0xff;
  const level = rdp === 0xaa ? "Level 0" : rdp === 0xcc ? "Level 2" : "Level 1";
  const bit = (n: number): number => (optr >>> n) & 1;
  return `RDP ${hex(rdp, 2)} (${level}), nSWBOOT0 ${bit(26)}, nBOOT0 ${bit(27)}, DBANK ${bit(22)}, BFB2 ${bit(20)}`;
}

export function printReadings(readings: G4Readings): void {
  console.log(`DEV_ID      ${hex(readings.devId, 3)}${readings.devId === 0x469 ? " (STM32G47x/G48x)" : " (not a G47x)"}`);
  console.log(`Flash size  ${readings.flashSizeKb === undefined ? "unreadable" : `${readings.flashSizeKb} KB`}`);
  console.log(`UID         ${readings.uid ?? "unreadable"}`);
  console.log(`FLASH_OPTR  ${hex(readings.optr)}  ${describeOptr(readings.optr)}`);
  const registers: [string, number][] = [
    ["WRP1AR", readings.wrp1ar],
    ["WRP1BR", readings.wrp1br],
    ["WRP2AR", readings.wrp2ar],
    ["WRP2BR", readings.wrp2br],
    ["PCROP1SR", readings.pcrop1sr],
    ["PCROP1ER", readings.pcrop1er],
    ["PCROP2SR", readings.pcrop2sr],
    ["PCROP2ER", readings.pcrop2er],
    ["SEC1R", readings.sec1r],
    ["SEC2R", readings.sec2r],
  ];
  for (const [name, value] of registers) console.log(`${name.padEnd(11)} ${hex(value)}`);

  if (!readings.flashHead) {
    console.log("Flash       not readable (read protection)");
    return;
  }
  const head = readings.flashHead;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const blank = head.every((byte) => byte === 0xff);
  console.log(`Flash head  ${blank ? "all 0xFF (blank)" : `SP ${hex(view.getUint32(0, true))}, reset vector ${hex(view.getUint32(4, true))}`}`);
  console.log(`            ${[...head.subarray(0, 32)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`Config      ${readings.configMagic === undefined ? "unreadable" : `${hex(readings.configMagic, 2)}${readings.configMagic === 0xbe ? " (Betaflight config stored)" : ""}`}`);
}
