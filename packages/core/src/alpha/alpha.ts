/**
 * Alpha Migrate: replacing the closed Alpha firmware on a T-Motor Pacer G4 Alpha with
 * Betaflight, over SWD. This module is pure: it classifies what the chip reports, checks
 * firmware images, and holds every warning the pilot must confirm. Hardware access lives
 * in the probe layers behind `G4Session`.
 *
 * The procedure follows the owner's recorded run in fix-thobby-g4-alpha/NOTES.md.
 */
import type { FcIdentity } from "../fc/identity.js";
import { isDemoImage } from "../firmware/demo-image.js";
import type { HexImage } from "../firmware/hex.js";
import { hex32 } from "../swd/memory-access.js";
import { decodeOptr, rdpLevelOf, type RdpLevel } from "../targets/stm32g4/option-bytes.js";
import { CONFIG_AREA, DEV_ID_G47X, FLASH_END, FLASH_SIZE_KB, FLASH_START, PAGE_SIZE } from "../targets/stm32g4/registers.js";
import type { G4Readings, ProbeInfo } from "../targets/stm32g4/session.js";

export type AlphaBoardId = "hd" | "analog";

export interface AlphaBoard {
  id: AlphaBoardId;
  label: string;
  /** The Betaflight board name a migrated board reports. */
  boardName: string;
  supported: boolean;
  note: string;
  /**
   * True when the migrated board comes up as a USB DFU device after `bl`, so new firmware can go
   * over USB. False means it is rewritten over SWD, as it was migrated.
   */
  usbDfu: boolean;
}

export const ALPHA_BOARDS: readonly AlphaBoard[] = [
  { id: "hd", label: "Pacer G4 Alpha HD", boardName: "TMOTORG4ALPHAHD", supported: true, note: "Migrated, configured and flown.", usbDfu: true },
  {
    id: "analog",
    label: "Pacer G4 Alpha Analog",
    boardName: "TMOTORG4ALPHAANALOG",
    supported: true,
    note: "Migrated and bench-tested on one board, not flown yet. Later firmware updates need the probe too.",
    // On the first migrated board, `bl` left USB half set up ("Device Descriptor Request Failed"),
    // twice. The likely cause is the OSD chip on PC10/PC11, which ST's bootloader also listens on.
    usbDfu: false,
  },
];

export function alphaBoard(id: AlphaBoardId): AlphaBoard {
  return ALPHA_BOARDS.find((board) => board.id === id)!;
}

/**
 * Betaflight's reserved ID for community configs of closed-source boards is COMM.
 * Boards flashed before the config switched to it report TMTR.
 */
export const ALPHA_MANUFACTURER_IDS: readonly string[] = ["COMM", "TMTR"];

/** Betaflight's settings area on the G474: four 2 KB pages from 0x08004000. */
const CONFIG_END = CONFIG_AREA + 4 * PAGE_SIZE;
/** Alpha images start after FETtec's 14 KB bootloader, which the migration erases for good. */
const ALPHA_IMAGE_START = 0x08003800;
const SRAM_START = 0x20000000;
const SRAM_END = 0x20020000;

/** The G4 Alpha board a board connected over USB is, when it already runs Betaflight. */
export function migratedAlphaBoard(identity: Pick<FcIdentity, "variant" | "board">): AlphaBoard | undefined {
  if (identity.variant !== "BTFL" || !ALPHA_MANUFACTURER_IDS.includes(identity.board.manufacturerId.toUpperCase())) return undefined;
  return ALPHA_BOARDS.find((board) => board.supported && board.boardName === identity.board.boardName);
}

/** True when a board connected over USB is a G4 Alpha already running Betaflight. */
export function isMigratedAlpha(identity: Pick<FcIdentity, "variant" | "board">): boolean {
  return migratedAlphaBoard(identity) !== undefined;
}

// ---------------------------------------------------------------------------
// Reading the chip

/** Protection the tested procedure has never met, by register. Empty when all are inactive. */
export function activeProtections(readings: G4Readings): string[] {
  const found: string[] = [];
  const wrp = (name: string, value: number) => {
    if ((value & 0x7f) <= ((value >>> 16) & 0x7f)) found.push(`${name} write protection`);
  };
  const pcrop = (name: string, start: number, end: number) => {
    if ((start & 0x7fff) <= (end & 0x7fff)) found.push(`${name} proprietary-code protection`);
  };
  wrp("Bank 1 area A", readings.wrp1ar);
  wrp("Bank 1 area B", readings.wrp1br);
  wrp("Bank 2 area A", readings.wrp2ar);
  wrp("Bank 2 area B", readings.wrp2br);
  pcrop("Bank 1", readings.pcrop1sr, readings.pcrop1er);
  pcrop("Bank 2", readings.pcrop2sr, readings.pcrop2er);
  if ((readings.sec1r & 0xff) !== 0) found.push("Bank 1 secure area");
  if ((readings.sec2r & 0xff) !== 0) found.push("Bank 2 secure area");
  if ((readings.sec1r >>> 16) & 1) found.push("boot lock");
  return found;
}

export type BoardKind =
  /** Not an STM32G47x with 512 KB: not a G4 Alpha. */
  | "wrong-chip"
  /** Protection the tested run never saw is active. */
  | "protected"
  /** Read protection Level 1: a stock Alpha board, or one bricked by a failed flash. */
  | "locked"
  /** Level 0 and empty: a migration stopped between the erase and the write. */
  | "blank"
  /** Level 0 with a valid program at the start of flash, most likely Betaflight. */
  | "programmed"
  /** Level 0 with something at the start of flash that is not a valid program. */
  | "unknown";

export interface Classification {
  kind: BoardKind;
  rdp: RdpLevel;
  bootPinHonoured: boolean;
  /** A Betaflight config is stored at 0x08004000. */
  hasSettings: boolean;
  protections: string[];
  title: string;
  detail: string;
}

function validVectorTable(head: Uint8Array): boolean {
  if (head.length < 8) return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const stack = view.getUint32(0, true);
  const reset = view.getUint32(4, true);
  return stack > SRAM_START && stack <= SRAM_END && (reset & 1) === 1 && reset >= FLASH_START && reset < FLASH_END;
}

export function classifyBoard(readings: G4Readings): Classification {
  const optr = decodeOptr(readings.optr);
  const rdp = rdpLevelOf(readings.optr);
  // nSWBOOT0 = 1 means the BOOT0 pin decides where the chip starts.
  const base = { rdp, bootPinHonoured: optr.nSwBoot0, hasSettings: readings.configMagic === 0xbe, protections: activeProtections(readings) };

  if (readings.devId !== DEV_ID_G47X || (readings.flashSizeKb !== undefined && readings.flashSizeKb !== FLASH_SIZE_KB)) {
    const size = readings.flashSizeKb === undefined ? "" : ` with ${readings.flashSizeKb} KB of flash`;
    return { ...base, kind: "wrong-chip", title: "Not a G4 Alpha", detail: `The chip reports ID 0x${readings.devId.toString(16)}${size}. A G4 Alpha has an STM32G473 (ID 0x469, 512 KB). Nothing has been changed.` };
  }
  if (rdp === 2 || base.protections.length > 0) {
    const what = rdp === 2 ? ["read protection Level 2"] : base.protections;
    return { ...base, kind: "protected", title: "Protection the procedure has never met", detail: `This board has ${what.join(", ")}. The tested procedure has never seen that, so it stops here. Nothing has been changed. Please save the board report and share it.` };
  }
  if (rdp === 1) {
    return { ...base, kind: "locked", title: "Locked, as a stock Alpha board is", detail: "Read protection is at Level 1. The firmware cannot be read or backed up, and removing the protection erases the whole chip." };
  }
  const head = readings.flashHead;
  if (head && head.every((byte) => byte === 0xff)) {
    return { ...base, kind: "blank", title: "Unlocked and empty", detail: "A migration stopped after the erase. It can continue from the write step; nothing else needs erasing." };
  }
  if (head && validVectorTable(head)) {
    return {
      ...base,
      kind: "programmed",
      title: "Unlocked, with firmware on it",
      detail: base.hasSettings ? "This board is already migrated and has saved settings. Rewriting it can keep them." : "This board is already migrated. No saved settings were found.",
    };
  }
  return { ...base, kind: "unknown", title: "Unlocked, with unrecognised contents", detail: "The start of flash is not a valid program. Writing Betaflight replaces whatever is there." };
}

// ---------------------------------------------------------------------------
// Checking a firmware image

export interface ImageCheck {
  ok: boolean;
  /** Reasons the image must not be written. */
  errors: string[];
  /** Things the pilot should know before writing it. */
  warnings: string[];
  /** The board name found in the image, when there is one. */
  boardName?: string;
  bytes: number;
  /** True when the image overwrites the settings area, so a rewrite cannot keep settings. */
  coversSettings: boolean;
  /** True for the demo's stand-in image, which only the simulated board accepts. */
  demo: boolean;
}

export interface ImageCheckOptions {
  board?: AlphaBoard;
  /**
   * False only when the image is for the simulated board. Defaults to true, so an image
   * checked without saying where it goes is held to the real-hardware rules.
   */
  forHardware?: boolean;
}

/** Vector table entries a G4 needs before Betaflight can catch anything: reset, NMI and HardFault. */
const REQUIRED_VECTORS = [4, 8, 12];

/** True when the address holds bytes from the image. */
function inImage(image: HexImage, address: number): boolean {
  return image.data.some((block) => address >= block.address && address < block.address + block.bytes.length);
}

function contains(image: HexImage, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  return image.data.some((block) => {
    const bytes = block.bytes;
    outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  });
}

function bytesAt(image: HexImage, address: number, length: number): Uint8Array | undefined {
  const block = image.data.find((entry) => address >= entry.address && address + length <= entry.address + entry.bytes.length);
  return block ? block.bytes.subarray(address - block.address, address - block.address + length) : undefined;
}

/** Decides whether an image is safe to write to a G4 Alpha. */
export function checkAlphaImage(image: HexImage, options: ImageCheckOptions = {}): ImageCheck {
  const board = options.board ?? ALPHA_BOARDS[0]!;
  const errors: string[] = [];
  const warnings: string[] = [];
  const lowest = Math.min(...image.data.map((block) => block.address));
  const outside = image.data.find((block) => block.address < FLASH_START || block.address + block.bytes.length > FLASH_END);
  const coversSettings = image.data.some((block) => block.address < CONFIG_END && block.address + block.bytes.length > CONFIG_AREA);
  const demo = isDemoImage(image.data);

  if (image.data.length === 0 || image.bytesTotal === 0) {
    errors.push("The file holds no firmware.");
    return { ok: false, errors, warnings, bytes: 0, coversSettings, demo };
  }
  if (demo && options.forHardware !== false) errors.push("This is the demo's stand-in image, not firmware. A real board would lock up on it, so only the simulated board accepts it.");
  if (outside) errors.push(`It writes outside the main flash, at 0x${outside.address.toString(16)}. That could change option bytes, so it is refused.`);
  if (lowest === ALPHA_IMAGE_START) errors.push("This is an Alpha firmware image. It needs FETtec's bootloader, which the migration erases for good, so it cannot run.");
  else if (lowest !== FLASH_START) errors.push(`It starts at 0x${lowest.toString(16)}, not at the start of flash (0x08000000), so the board would not boot.`);

  const head = bytesAt(image, FLASH_START, 16);
  if (lowest === FLASH_START && (!head || !validVectorTable(head))) errors.push("Its first bytes are not a valid program start, so the board would not boot.");
  else if (head) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const handlers = REQUIRED_VECTORS.map((offset) => view.getUint32(offset, true));
    // Each must be a Thumb address the image itself writes; anything else faults into lockup.
    if (handlers.some((handler) => (handler & 1) !== 1 || !inImage(image, handler & ~1))) {
      errors.push("Its reset or fault handlers point outside the file, so the board would lock up instead of starting.");
    }
  }
  if (!contains(image, "Betaflight") && !contains(image, "BTFL")) errors.push("It does not look like Betaflight.");

  let boardName: string | undefined;
  // The two Alpha boards share a chip, so each one's build also names STM32G474.
  const sibling = ALPHA_BOARDS.find((other) => other.id !== board.id && contains(image, other.boardName));
  if (contains(image, board.boardName)) boardName = board.boardName;
  else if (sibling) {
    boardName = sibling.boardName;
    warnings.push(`This is the build for the ${sibling.label}, not the ${board.label}. The two boards wire their OSD differently, so the OSD would not work.`);
  } else if (contains(image, "STM32G474")) {
    boardName = "STM32G474";
    warnings.push("This is Betaflight's generic G474 build. It needs the board's pin script pasted in the CLI afterwards, and it lacks the battery-voltage and ESC-telemetry fixes.");
  } else warnings.push(`This image does not name ${board.boardName}. Firmware for another board has the wrong pins and may not fly.`);

  if (coversSettings) warnings.push("It also writes the settings area, so any saved Betaflight settings are replaced.");
  return { ok: errors.length === 0, errors, warnings, boardName, bytes: image.bytesTotal, coversSettings, demo };
}

// ---------------------------------------------------------------------------
// The board report

export interface BoardReport {
  tool: "Betaflight Migrator, Alpha Migrate";
  savedAt: string;
  simulated: boolean;
  /** The board the pilot said it is. Both boards have the same chip, so the chip cannot tell them apart. */
  board?: string;
  probe: ProbeInfo;
  chip: { devId: string; flashSizeKb?: number; uid?: string };
  optionBytes: Record<string, string>;
  classification: { kind: BoardKind; title: string; rdpLevel: RdpLevel; bootPinHonoured: boolean; protections: string[] };
  confirmations: { id: string; version: number; at: string }[];
}

/** Everything readable from the board before it changes. It stays on the pilot's computer. */
export function buildBoardReport(input: { probe: ProbeInfo; readings: G4Readings; classification: Classification; confirmations: BoardReport["confirmations"]; simulated: boolean; board?: AlphaBoard; at?: Date }): BoardReport {
  const { readings, classification } = input;
  return {
    tool: "Betaflight Migrator, Alpha Migrate",
    savedAt: (input.at ?? new Date()).toISOString(),
    simulated: input.simulated,
    board: input.board?.boardName,
    probe: input.probe,
    chip: { devId: `0x${readings.devId.toString(16)}`, flashSizeKb: readings.flashSizeKb, uid: readings.uid },
    optionBytes: {
      OPTR: hex32(readings.optr),
      WRP1AR: hex32(readings.wrp1ar),
      WRP1BR: hex32(readings.wrp1br),
      WRP2AR: hex32(readings.wrp2ar),
      WRP2BR: hex32(readings.wrp2br),
      PCROP1SR: hex32(readings.pcrop1sr),
      PCROP1ER: hex32(readings.pcrop1er),
      PCROP2SR: hex32(readings.pcrop2sr),
      PCROP2ER: hex32(readings.pcrop2er),
      SEC1R: hex32(readings.sec1r),
      SEC2R: hex32(readings.sec2r),
    },
    classification: { kind: classification.kind, title: classification.title, rdpLevel: classification.rdp, bootPinHonoured: classification.bootPinHonoured, protections: classification.protections },
    confirmations: input.confirmations,
  };
}

// ---------------------------------------------------------------------------
// What the pilot reads and confirms. Each text has an id and a version, and the
// report records which ones were confirmed, so the wording a pilot agreed to is known.

export interface AlphaText {
  id: string;
  version: number;
  title: string;
  paragraphs: string[];
  /** Separate statements, each with its own checkbox. */
  checks?: string[];
  /** A word the pilot must type to continue. */
  typed?: string;
}

export const ALPHA_TEXTS = {
  intro: {
    id: "C1",
    version: 3,
    title: "Alpha Migrate changes your flight controller for good",
    paragraphs: [
      "It replaces the Alpha firmware on a T-Motor Pacer G4 Alpha, HD or Analog, with Betaflight. This is an unofficial community procedure. T-Motor, FETtec and Betaflight do not support it. One step erases the whole chip, and after it the board can never run Alpha again.",
      "You need a debug probe, three wires soldered to the board, and Chrome or Edge. The probe can be an ST-Link V2 (or V2-1), or a Flipper Zero running its DAP Link app.",
      "Before you start, write down any Alpha settings you want to keep, such as rates, the motor output map and the receiver protocol. They cannot be copied off the board.",
    ],
    checks: ["I understand that one step cannot be undone, and that this board will never run Alpha again."],
  },
  givesUp: {
    id: "C1b",
    version: 2,
    title: "What the HD board gives up",
    paragraphs: [
      "Most of the board carries over: OSD, power and SBUS on the DJI plug, ESC telemetry, the LED strip and the beeper. ESC telemetry has one known flaw on the board tested so far. Some of its frames arrive corrupted, so with it turned on the stats screen after a flight can show an impossible maximum current, RPM or temperature. Flying is not affected. What you lose:",
      "The receiver plug, for a CRSF or ELRS receiver. Alpha reads the receiver in software on a pin with no serial port, which Betaflight cannot do. Under Betaflight the receiver goes on the T1 and R1 pads.",
      "DShot2400. Betaflight's RPM filtering needs bidirectional DShot, which on this chip runs at DShot300 with a 4 kHz PID loop.",
      "Alpha itself: its configurator, its updates and any way back.",
    ],
  },
  givesUpAnalog: {
    id: "C1c",
    version: 2,
    title: "What the Analog board gives up",
    paragraphs: [
      "One Analog board has been migrated and checked on the bench: the OSD through the board's own OSD chip, SmartAudio VTX control on T3, the receiver on T1 and R1, ESC telemetry, motor order and battery voltage. Its beeper and LEDs are untested, and it has not flown yet. What you lose:",
      "The receiver group's SIG and TLM pads, for a CRSF or ELRS receiver. On the HD board they reach no serial port Betaflight can use, and this board is likely the same. Under Betaflight the receiver goes on the T1 and R1 pads, which worked on the tested board.",
      "Firmware updates over USB. On the tested board, Betaflight's bootloader command left USB stuck instead of starting the USB bootloader, so later updates go through the probe and this page again.",
      "Updates to the OSD chip. They go through Alpha, so update it to 0.1.18 in FETtec's configurator before you start: the tested board ran 0.1.18.",
      "Betaflight's logo on the boot screen. The OSD chip's font does not have it, so letters stand in.",
      "Alpha itself: its configurator, its updates and any way back.",
    ],
  },
  wiring: {
    id: "C2",
    version: 3,
    title: "Wire the probe",
    paragraphs: [
      "Tick each step off as you go, if it helps. Continue does not wait for the ticks.",
      "On an ST-Link, go by the labels printed on it. On a Flipper Zero running DAP Link, SWCLK is pin 2 (A7), SWDIO is pin 3 (A6), and GND is pin 8, 11 or 18. On a Raspberry Pi Pico running debugprobe, SWCLK is GP2, SWDIO is GP3, and GND is any GND pin.",
    ],
    checks: [
      "Unplug the battery. The board runs from its USB-C for the whole job.",
      "Unplug the receiver and the DJI cable. The probe's clock wire uses the same pin as the receiver's signal and the DJI SBUS wire.",
      "Solder GND first, to the upper gold pad on the right edge (or any GND pad on the other side). Then the probe's SWCLK to the lower gold pad beside the USB-C socket, and SWDIO to the upper one. Check that GND is still attached before plugging anything in: a probe that loses GND while its other wires stay on can be damaged.",
      "Leave the probe's 3.3V and reset pins unconnected.",
    ],
  },
  wiringAnalog: {
    id: "C2c",
    version: 2,
    title: "Wire the probe",
    paragraphs: [
      "Tick each step off as you go, if it helps. Continue does not wait for the ticks.",
      "On an ST-Link, go by the labels printed on it. On a Flipper Zero running DAP Link, SWCLK is pin 2 (A7), SWDIO is pin 3 (A6), and GND is pin 8, 11 or 18. On a Raspberry Pi Pico running debugprobe, SWCLK is GP2, SWDIO is GP3, and GND is any GND pin.",
    ],
    checks: [
      "Unplug the battery. The board runs from its USB-C for the whole job.",
      "Unplug the receiver. On the HD board the receiver's signal pin is the probe's clock pin.",
      "Solder GND first, to the upper gold pad on the right edge. Then the probe's SWCLK to the lower gold pad beside the USB-C socket, and SWDIO to the upper one. Check that GND is still attached before plugging anything in: a probe that loses GND while its other wires stay on can be damaged.",
      "Leave the probe's 3.3V and reset pins unconnected.",
    ],
  },
  probe: {
    id: "C3",
    version: 3,
    title: "Choose the probe",
    paragraphs: [
      "Click Select probe and choose yours in your browser's list. Only one program can use a probe at a time, so close STM32CubeProgrammer and OpenOCD first.",
      'ST-Link: it is listed as "STM32 STLink". If the list is empty, the driver is missing: install ST\'s STSW-LINK009 driver and plug the ST-Link in again.',
      "Flipper Zero: start the DAP Link app before you choose it. It is listed as \"Combined VCP and CMSIS-DAP Adapter\". A flight controller plugged in at the same time is listed too, under its Betaflight name, because it shares the Flipper's USB IDs. On Windows, if the Flipper cannot be opened, ST's COM port driver may hold it: in Device Manager, set its driver to USB Composite Device and plug it in again.",
      "Raspberry Pi Pico running debugprobe: offered, but not yet tried on this board.",
    ],
  },
  usbPower: {
    id: "C3b",
    version: 2,
    title: "Plug the board's USB-C into the computer first.",
    paragraphs: ["The probe's 3.3V wire is not connected, so the probe does not power the board, and without power it cannot find the chip. Keep the cable in until Alpha Migrate says it is done."],
  },
  holdReset: {
    id: "C4a",
    version: 3,
    title: "Connect while holding reset",
    paragraphs: [
      "The probe could not reach the chip. Check the three wires and that the board's USB-C is plugged in. A board still running Alpha may also be using the probe's clock pin.",
      "Press and hold the reset button beside the USB-C socket, then click Connect while still holding it. When the app says Connected, release the button.",
    ],
  },
  confirmChip: {
    id: "C4",
    version: 1,
    title: "Is this the board you want to convert?",
    paragraphs: ["Check the details below. If anything looks wrong, stop here: nothing has been changed yet."],
  },
  report: {
    id: "C5",
    version: 1,
    title: "Save the board report",
    paragraphs: [
      "Save this report before going on. It holds everything that can be read from a locked Alpha board: its option bytes, protection settings and unique ID. The firmware itself cannot be read, because read protection blocks it.",
      "The report stays on your computer. Nothing is uploaded.",
    ],
  },
  firmware: {
    id: "C6",
    version: 1,
    title: "Choose the firmware",
    paragraphs: [
      "Choose a Betaflight .hex file built for TMOTORG4ALPHAHD. The community build carries two fixes the official generic G474 build lacks: a steady battery voltage reading, and a working ESC telemetry port.",
      "It is not an official Betaflight cloud build. The file is checked before anything is written.",
    ],
  },
  firmwareAnalog: {
    id: "C6c",
    version: 1,
    title: "Choose the firmware",
    paragraphs: [
      "Choose a Betaflight .hex file built for TMOTORG4ALPHAANALOG. The official cloud build does not have this board. fc-migrate's build carries the HD build's two fixes, a steady battery voltage reading and a working ESC telemetry port, plus a third for the OSD: the board's OSD chip clears its screen the moment Betaflight asks, so stock Betaflight makes it flicker.",
      "The file is checked before anything is written.",
    ],
  },
  bootPin: {
    id: "C6b",
    version: 1,
    title: "Switch off the BOOT0 pin",
    paragraphs: ["This board's BOOT0 pin is switched on. Under Betaflight, a DJI air unit on R3 can hold that pin high and make the board start in its bootloader instead of Betaflight. Switching it off in the same step is recommended."],
  },
  unlock: {
    id: "C7",
    version: 2,
    title: "Erase the board and remove read protection",
    paragraphs: [
      "This step cannot be undone.",
      "The chip erases all of its flash: the Alpha firmware, your Alpha settings, and FETtec's bootloader.",
      "FETtec's bootloader has never been published and cannot be read off a locked chip, so no one can put it back. This board will never run Alpha or update from the Alpha configurator again.",
      "Until the next step finishes, the board does nothing when plugged into USB. That is expected. The probe can always finish the job.",
      "Keep the USB cable and the probe connected until the app says it is done.",
    ],
    typed: "ERASE",
  },
  write: {
    id: "C8",
    version: 1,
    title: "Write Betaflight",
    paragraphs: ["The flash is empty, so nothing is lost. If this step is interrupted, open Alpha Migrate again: it finds the empty board and continues from here."],
  },
  rewrite: {
    id: "C8r",
    version: 1,
    title: "Rewrite the firmware",
    paragraphs: ["This board is already unlocked. Only the parts of flash the new firmware uses are erased, so saved settings are kept. Turn off Keep my settings for a full erase."],
  },
  done: {
    id: "C9",
    version: 2,
    title: "Betaflight is on the board",
    paragraphs: [
      "Before you fly, unsolder or unplug the probe's wires. The clock wire shares a pin with the receiver plug and the DJI SBUS wire.",
      "Wire your receiver to T1 and R1. The receiver plug cannot carry CRSF under Betaflight.",
      "Then connect over USB to set the board up. Later firmware updates go over USB; the probe is only needed to recover a board that will not start.",
    ],
  },
  doneAnalog: {
    id: "C9c",
    version: 2,
    title: "Betaflight is on the board",
    paragraphs: [
      "Before you fly, unsolder or unplug the probe's wires. On the HD board the clock wire shares a pin with the receiver's signal pin.",
      "Wire your receiver to T1 and R1.",
      "Then connect over USB to set the board up. Set vcd_video_system to PAL or NTSC to match your camera: Auto gives the shorter NTSC screen. Betaflight turns on only the warnings at first, so add the OSD elements you want, and load a VTX table before changing channel or power.",
      "Check the board orientation before the first flight: tilt the quad and watch the model in Configurator's Setup tab. This board's gyro alignment is carried over from the HD board and has not been checked.",
      "Later firmware updates go through the probe and this page again. A rewrite keeps your settings.",
    ],
  },
} as const satisfies Record<string, AlphaText>;

export type AlphaTextKey = keyof typeof ALPHA_TEXTS;

/** Texts that differ by board. A key not listed here is the same for every board. */
const BOARD_TEXTS: Record<AlphaBoardId, Partial<Record<AlphaTextKey, AlphaTextKey>>> = {
  hd: {},
  analog: { givesUp: "givesUpAnalog", wiring: "wiringAnalog", firmware: "firmwareAnalog", done: "doneAnalog" },
};

/** The key of the text a board shows in place of `key`. */
export function alphaTextKey(key: AlphaTextKey, board: AlphaBoardId): AlphaTextKey {
  return BOARD_TEXTS[board][key] ?? key;
}
