/**
 * Alpha Migrate: replacing the closed Alpha firmware on a T-Motor Pacer G4 Alpha with
 * Betaflight, over SWD. This module is pure: it classifies what the chip reports, checks
 * firmware images, and holds every warning the pilot must confirm. Hardware access lives
 * in the ST-Link layer behind `G4Session`.
 *
 * The procedure follows the owner's recorded run in fix-thobby-g4-alpha/NOTES.md.
 */
import type { FcIdentity } from "../fc/identity.js";
import type { HexImage } from "../firmware/hex.js";
import { hex32 } from "../swd/memory-access.js";
import { decodeOptr, rdpLevelOf, type RdpLevel } from "../targets/stm32g4/option-bytes.js";
import { CONFIG_AREA, DEV_ID_G47X, FLASH_END, FLASH_SIZE_KB, FLASH_START, PAGE_SIZE } from "../targets/stm32g4/registers.js";
import type { G4Readings, ProbeInfo } from "../targets/stm32g4/session.js";

export interface AlphaBoard {
  id: "hd" | "analog";
  label: string;
  /** The Betaflight board name a migrated board reports. */
  boardName: string;
  supported: boolean;
  note: string;
}

export const ALPHA_BOARDS: readonly AlphaBoard[] = [
  { id: "hd", label: "Pacer G4 Alpha HD", boardName: "TMOTORG4ALPHAHD", supported: true, note: "Migrated, configured and flown." },
  { id: "analog", label: "Pacer G4 Alpha Analog", boardName: "TMOTORG4ALPHA", supported: false, note: "Coming soon. Its pins, OSD chip and SWD pads are not mapped yet." },
];

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

/** True when a board connected over USB is a G4 Alpha already running Betaflight. */
export function isMigratedAlpha(identity: Pick<FcIdentity, "variant" | "board">): boolean {
  return (
    identity.variant === "BTFL" &&
    ALPHA_BOARDS.some((board) => board.supported && board.boardName === identity.board.boardName) &&
    ALPHA_MANUFACTURER_IDS.includes(identity.board.manufacturerId.toUpperCase())
  );
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
export function checkAlphaImage(image: HexImage, board: AlphaBoard = ALPHA_BOARDS[0]!): ImageCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lowest = Math.min(...image.data.map((block) => block.address));
  const outside = image.data.find((block) => block.address < FLASH_START || block.address + block.bytes.length > FLASH_END);
  const coversSettings = image.data.some((block) => block.address < CONFIG_END && block.address + block.bytes.length > CONFIG_AREA);

  if (image.data.length === 0 || image.bytesTotal === 0) {
    errors.push("The file holds no firmware.");
    return { ok: false, errors, warnings, bytes: 0, coversSettings };
  }
  if (outside) errors.push(`It writes outside the main flash, at 0x${outside.address.toString(16)}. That could change option bytes, so it is refused.`);
  if (lowest === ALPHA_IMAGE_START) errors.push("This is an Alpha firmware image. It needs FETtec's bootloader, which the migration erases for good, so it cannot run.");
  else if (lowest !== FLASH_START) errors.push(`It starts at 0x${lowest.toString(16)}, not at the start of flash (0x08000000), so the board would not boot.`);

  const head = bytesAt(image, FLASH_START, 8);
  if (lowest === FLASH_START && (!head || !validVectorTable(head))) errors.push("Its first bytes are not a valid program start, so the board would not boot.");
  if (!contains(image, "Betaflight") && !contains(image, "BTFL")) errors.push("It does not look like Betaflight.");

  let boardName: string | undefined;
  if (contains(image, board.boardName)) boardName = board.boardName;
  else if (contains(image, "STM32G474")) {
    boardName = "STM32G474";
    warnings.push("This is Betaflight's generic G474 build. It needs the board's pin script pasted in the CLI afterwards, and it lacks the battery-voltage and ESC-telemetry fixes.");
  } else warnings.push(`This image does not name ${board.boardName}. Firmware for another board has the wrong pins and may not fly.`);

  if (coversSettings) warnings.push("It also writes the settings area, so any saved Betaflight settings are replaced.");
  return { ok: errors.length === 0, errors, warnings, boardName, bytes: image.bytesTotal, coversSettings };
}

// ---------------------------------------------------------------------------
// The board report

export interface BoardReport {
  tool: "Betaflight Migrator, Alpha Migrate";
  savedAt: string;
  simulated: boolean;
  probe: ProbeInfo;
  chip: { devId: string; flashSizeKb?: number; uid?: string };
  optionBytes: Record<string, string>;
  classification: { kind: BoardKind; title: string; rdpLevel: RdpLevel; bootPinHonoured: boolean; protections: string[] };
  confirmations: { id: string; version: number; at: string }[];
}

/** Everything readable from the board before it changes. It stays on the pilot's computer. */
export function buildBoardReport(input: { probe: ProbeInfo; readings: G4Readings; classification: Classification; confirmations: BoardReport["confirmations"]; simulated: boolean; at?: Date }): BoardReport {
  const { readings, classification } = input;
  return {
    tool: "Betaflight Migrator, Alpha Migrate",
    savedAt: (input.at ?? new Date()).toISOString(),
    simulated: input.simulated,
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
    version: 1,
    title: "Alpha Migrate changes your flight controller for good",
    paragraphs: [
      "It replaces the Alpha firmware on a T-Motor Pacer G4 Alpha HD with Betaflight. This is an unofficial community procedure. T-Motor, FETtec and Betaflight do not support it. One step erases the whole chip, and after it the board can never run Alpha again.",
      "You need an ST-Link V2 (or V2-1), three wires soldered to the board, and Chrome or Edge.",
      "Before you start, write down any Alpha settings you want to keep, such as rates, the motor output map and the receiver protocol. They cannot be copied off the board.",
      "Only the HD version is supported. Analog is coming soon.",
    ],
    checks: ["I understand that one step cannot be undone, and that this board will never run Alpha again."],
  },
  givesUp: {
    id: "C1b",
    version: 1,
    title: "What the HD board gives up",
    paragraphs: [
      "Most of the board carries over: OSD, power and SBUS on the DJI plug, ESC telemetry, the LED strip and the beeper. What you lose:",
      "The receiver plug, for a CRSF or ELRS receiver. Alpha reads the receiver in software on a pin with no serial port, which Betaflight cannot do. Under Betaflight the receiver goes on the T1 and R1 pads.",
      "DShot2400. Betaflight's RPM filtering needs bidirectional DShot, which on this chip runs at DShot300 with a 4 kHz PID loop.",
      "Alpha itself: its configurator, its updates and any way back.",
    ],
  },
  wiring: {
    id: "C2",
    version: 2,
    title: "Wire the ST-Link",
    paragraphs: ["Tick each step off as you go, if it helps. Continue does not wait for the ticks."],
    checks: [
      "Unplug the battery. The board runs from its USB-C for the whole job.",
      "Unplug the receiver and the DJI cable. The ST-Link's clock wire uses the same pin as the receiver's signal and the DJI SBUS wire.",
      "Solder GND first, to the upper gold pad on the right edge (or any GND pad on the other side). Then ST-Link SWCLK to the lower gold pad beside the USB-C socket, and SWDIO to the upper one.",
      "Leave the ST-Link's 3.3V and RST pins unconnected.",
    ],
  },
  probe: {
    id: "C3",
    version: 1,
    title: "Choose the ST-Link",
    paragraphs: [
      'Click Select ST-Link and choose "STM32 STLink" in your browser\'s list. If the list is empty, the ST-Link driver is missing: install ST\'s STSW-LINK009 driver and plug the ST-Link in again.',
      "Close STM32CubeProgrammer first. Only one program can use the ST-Link at a time.",
    ],
  },
  usbPower: {
    id: "C3b",
    version: 1,
    title: "Plug the board's USB-C into the computer first.",
    paragraphs: ["The ST-Link's 3.3V wire is not connected, so the ST-Link does not power the board, and without power it cannot find the chip. Keep the cable in until Alpha Migrate says it is done."],
  },
  holdReset: {
    id: "C4a",
    version: 2,
    title: "Connect while holding reset",
    paragraphs: [
      "The ST-Link could not reach the chip. Check the three wires and that the board's USB-C is plugged in. A board still running Alpha may also be using the ST-Link's clock pin.",
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
  bootPin: {
    id: "C6b",
    version: 1,
    title: "Switch off the BOOT0 pin",
    paragraphs: ["This board's BOOT0 pin is switched on. Under Betaflight, a DJI air unit on R3 can hold that pin high and make the board start in its bootloader instead of Betaflight. Switching it off in the same step is recommended."],
  },
  unlock: {
    id: "C7",
    version: 1,
    title: "Erase the board and remove read protection",
    paragraphs: [
      "This step cannot be undone.",
      "The chip erases all of its flash: the Alpha firmware, your Alpha settings, and FETtec's bootloader.",
      "FETtec's bootloader has never been published and cannot be read off a locked chip, so no one can put it back. This board will never run Alpha or update from the Alpha configurator again.",
      "Until the next step finishes, the board does nothing when plugged into USB. That is expected. The ST-Link can always finish the job.",
      "Keep the USB cable and the ST-Link connected until the app says it is done.",
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
    version: 1,
    title: "Betaflight is on the board",
    paragraphs: [
      "Before you fly, unsolder or unplug the ST-Link wires. The clock wire shares a pin with the receiver plug and the DJI SBUS wire.",
      "Wire your receiver to T1 and R1. The receiver plug cannot carry CRSF under Betaflight.",
      "Then connect over USB to set the board up. Later firmware updates go over USB; the ST-Link is only needed to recover a board that will not start.",
    ],
  },
} as const satisfies Record<string, AlphaText>;

export type AlphaTextKey = keyof typeof ALPHA_TEXTS;
