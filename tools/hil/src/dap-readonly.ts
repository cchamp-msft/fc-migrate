/**
 * Reads an STM32G4 board through a CMSIS-DAP v2 probe (a Flipper Zero running its DAP
 * Link app, or a Pico running debugprobe) with the same session code the web app uses,
 * prints what it found, and closes. Read-only: it never removes read protection,
 * erases, programs or resets the chip. A core halted by --hold-reset is resumed on close.
 *
 *   dap                     attach without reset (the board keeps running)
 *   dap --hold-reset        hold the board's reset button first; release it when told
 *   --clock <kHz>           SWD clock (default 480)
 *
 * The chooser's USB IDs are shared with other devices (the Flipper's with most STM32
 * USB serial devices), so every match is tried until one has a CMSIS-DAP interface.
 */
import { WebUSB } from "usb";
import { CMSIS_DAP_USB_FILTERS, openCmsisDapG4Session, SessionError, type UsbBulkDeviceLike } from "@bf-migrate/core";
import { printReadings } from "./g4-report.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const holdReset = process.argv.includes("--hold-reset");
const clockKhz = Number(option("clock") ?? 480);

const webusb = new WebUSB({ allowAllDevices: true });
const candidates = (await webusb.getDevices()).filter((device) =>
  CMSIS_DAP_USB_FILTERS.some((filter) => filter.vendorId === device.vendorId && filter.productId === device.productId),
);
if (candidates.length === 0) {
  console.error("No CMSIS-DAP probe found. On a Flipper Zero, start the DAP Link app. On Windows, check the driver.");
  process.exit(1);
}

if (holdReset) console.log(">>> Press and HOLD the board's reset button now. Connecting in 3 s...");
if (holdReset) await new Promise((resolve) => setTimeout(resolve, 3000));

let lastError: unknown;
for (const device of candidates) {
  try {
    const session = await openCmsisDapG4Session(device as unknown as UsbBulkDeviceLike, {
      mode: holdReset ? "holdReset" : "hotplug",
      clockKhz,
      onAttached: () => console.log(">>> Connected. RELEASE the reset button now."),
    });
    try {
      const { model, firmware } = session.probe;
      console.log(`Probe       ${model}, firmware ${firmware}`);
      printReadings(await session.readAll());
    } finally {
      await session.close();
    }
    process.exit(0);
  } catch (error) {
    lastError = error;
    // A device with the same IDs but no CMSIS-DAP interface: try the next one.
    if (error instanceof SessionError && error.kind === "probe-firmware" && error.message.includes("no CMSIS-DAP v2 interface")) continue;
    break;
  }
}

if (lastError instanceof SessionError) {
  console.error(`Failed (${lastError.kind}): ${lastError.message}`);
  if (lastError.kind === "no-target" && !holdReset) console.error("If the firmware uses the SWCLK pin, try again with --hold-reset.");
  process.exit(2);
}
throw lastError;
