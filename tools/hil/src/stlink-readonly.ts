/**
 * Reads an STM32G4 board through a real ST-Link with the same session code the web app
 * uses, prints what it found, and closes. Read-only: it never removes read protection,
 * erases, programs or resets the chip. A core halted by --hold-reset is resumed on close.
 *
 *   stlink                  attach without reset (the board keeps running)
 *   stlink --hold-reset     hold the board's reset button first; release it when told
 *   --clock <kHz>           SWD clock (default 480)
 */
import { WebUSB } from "usb";
import { openStlinkG4Session, SessionError, STLINK_USB_FILTERS, type G4Readings, type UsbBulkDeviceLike } from "@bf-migrate/core";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const holdReset = process.argv.includes("--hold-reset");
const clockKhz = Number(option("clock") ?? 480);

const hex = (value: number, digits = 8): string => `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, "0")}`;

function describeOptr(optr: number): string {
  const rdp = optr & 0xff;
  const level = rdp === 0xaa ? "Level 0" : rdp === 0xcc ? "Level 2" : "Level 1";
  const bit = (n: number): number => (optr >>> n) & 1;
  return `RDP ${hex(rdp, 2)} (${level}), nSWBOOT0 ${bit(26)}, nBOOT0 ${bit(27)}, DBANK ${bit(22)}, BFB2 ${bit(20)}`;
}

function print(readings: G4Readings): void {
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

const webusb = new WebUSB({ allowAllDevices: true });
const devices = await webusb.getDevices();
const device = devices.find((candidate) => STLINK_USB_FILTERS.some((filter) => filter.vendorId === candidate.vendorId && filter.productId === candidate.productId));
if (!device) {
  console.error("No ST-Link/V2 or V2-1 found. Check the driver, and close STM32CubeProgrammer.");
  process.exit(1);
}

if (holdReset) console.log(">>> Press and HOLD the board's reset button now. Connecting in 3 s...");
if (holdReset) await new Promise((resolve) => setTimeout(resolve, 3000));

try {
  const session = await openStlinkG4Session(device as unknown as UsbBulkDeviceLike, {
    mode: holdReset ? "holdReset" : "hotplug",
    clockKhz,
    onAttached: () => console.log(">>> Connected. RELEASE the reset button now."),
  });
  try {
    const { model, firmware, targetVolts } = session.probe;
    console.log(`Probe       ${model}, firmware ${firmware}, target ${targetVolts === undefined ? "unknown" : `${targetVolts.toFixed(2)} V`}`);
    print(await session.readAll());
  } finally {
    await session.close();
  }
} catch (error) {
  if (error instanceof SessionError) {
    console.error(`Failed (${error.kind}): ${error.message}`);
    if (error.kind === "no-target" && !holdReset) console.error("If the firmware uses the SWCLK pin, try again with --hold-reset.");
    process.exit(2);
  }
  throw error;
}
