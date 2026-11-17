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
import { openStlinkG4Session, SessionError, STLINK_USB_FILTERS, type UsbBulkDeviceLike } from "@bf-migrate/core";
import { printReadings } from "./g4-report.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const holdReset = process.argv.includes("--hold-reset");
const clockKhz = Number(option("clock") ?? 480);

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
    printReadings(await session.readAll());
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
