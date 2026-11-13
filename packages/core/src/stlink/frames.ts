/**
 * ST-Link USB protocol: pure builders for the 16-byte command blocks and parsers for
 * the replies. No I/O here.
 *
 * Every command is one 16-byte block on the bulk OUT endpoint, zero padded, optionally
 * followed by a data phase on OUT, then a fixed-length reply on IN. Multi-byte values
 * are little-endian except the version word. Codes follow OpenOCD's
 * src/jtag/drivers/stlink_usb.c (GPL-2.0-or-later) and devanlai/webstlink (MIT); no
 * code is copied from either.
 */

export const FRAME_LENGTH = 16;

/** First byte of a command block. */
export const StlinkCommand = {
  GET_VERSION: 0xf1,
  DEBUG: 0xf2,
  DFU: 0xf3,
  SWIM: 0xf4,
  GET_CURRENT_MODE: 0xf5,
  GET_TARGET_VOLTAGE: 0xf7,
} as const;

/** Second byte after StlinkCommand.DEBUG (JTAG API v2 numbering). */
export const DebugCommand = {
  GETSTATUS: 0x01,
  READMEM_32BIT: 0x07,
  WRITEMEM_32BIT: 0x08,
  EXIT: 0x21,
  ENTER: 0x30,
  READ_IDCODES: 0x31,
  RESETSYS: 0x32,
  WRITEDEBUGREG: 0x35,
  READDEBUGREG: 0x36,
  GETLASTRWSTATUS: 0x3b,
  DRIVE_NRST: 0x3c,
  GETLASTRWSTATUS2: 0x3e,
  SWD_SET_FREQ: 0x43,
} as const;

/** Second byte after StlinkCommand.DFU: leave the probe's own DFU mode. */
export const DFU_EXIT = 0x07;
/** Second byte after StlinkCommand.SWIM. */
export const SWIM_EXIT = 0x01;
/** Third byte of DEBUG ENTER: SWD without touching NRST. */
export const ENTER_SWD_NO_RESET = 0xa3;

/** GET_CURRENT_MODE answers. */
export const ProbeMode = {
  DFU: 0x00,
  MASS: 0x01,
  DEBUG: 0x02,
  SWIM: 0x03,
  BOOTLOADER: 0x04,
} as const;

/** First byte of a status reply. */
export const StlinkStatus = {
  OK: 0x80,
  FAULT: 0x81,
  JTAG_GET_IDCODE_ERROR: 0x09,
  JTAG_WRITE_ERROR: 0x0c,
  JTAG_WRITE_VERIF_ERROR: 0x0d,
  SWD_AP_WAIT: 0x10,
  SWD_AP_FAULT: 0x11,
  SWD_AP_ERROR: 0x12,
  SWD_AP_PARITY_ERROR: 0x13,
  SWD_DP_WAIT: 0x14,
  SWD_DP_FAULT: 0x15,
  SWD_DP_ERROR: 0x16,
  SWD_DP_PARITY_ERROR: 0x17,
  SWD_AP_WDATA_ERROR: 0x18,
  SWD_AP_STICKY_ERROR: 0x19,
  SWD_AP_STICKYORUN_ERROR: 0x1a,
  BAD_AP_ERROR: 0x1d,
} as const;

const STATUS_NAMES = new Map<number, string>(Object.entries(StlinkStatus).map(([name, code]) => [code, name]));

export function statusName(status: number): string {
  return STATUS_NAMES.get(status) ?? `0x${status.toString(16).padStart(2, "0")}`;
}

/** The probe asked to retry: the target's DP or AP answered WAIT. */
export function isWaitStatus(status: number): boolean {
  return status === StlinkStatus.SWD_AP_WAIT || status === StlinkStatus.SWD_DP_WAIT;
}

/** The debug port itself failed, as opposed to one bus access. */
export function isDebugPortStatus(status: number): boolean {
  return (
    status === StlinkStatus.JTAG_GET_IDCODE_ERROR ||
    status === StlinkStatus.SWD_DP_WAIT ||
    status === StlinkStatus.SWD_DP_FAULT ||
    status === StlinkStatus.SWD_DP_ERROR ||
    status === StlinkStatus.SWD_DP_PARITY_ERROR
  );
}

/** Reply lengths, in bytes. */
export const ReplyLength = {
  VERSION: 6,
  CURRENT_MODE: 2,
  TARGET_VOLTAGE: 8,
  STATUS: 2,
  IDCODES: 12,
  READ_DEBUG_REG: 8,
  RW_STATUS2: 12,
} as const;

/** SWD clock divisors the probe accepts, fastest first: [kHz, divisor]. */
export const SWD_CLOCKS: readonly (readonly [number, number])[] = [
  [4000, 0],
  [1800, 1],
  [1200, 2],
  [950, 3],
  [480, 7],
  [240, 15],
  [125, 31],
  [100, 40],
  [50, 79],
  [25, 158],
  [15, 265],
  [5, 798],
];

/** Picks the fastest supported SWD clock at or below `khz` (the slowest one if `khz` is below all). */
export function swdClockFor(khz: number): { khz: number; divisor: number } {
  const match = SWD_CLOCKS.find(([rate]) => rate <= khz) ?? SWD_CLOCKS[SWD_CLOCKS.length - 1]!;
  return { khz: match[0], divisor: match[1] };
}

function frame(...bytes: number[]): Uint8Array {
  const block = new Uint8Array(FRAME_LENGTH);
  block.set(bytes);
  return block;
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

export function readLe32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

export function readLe16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

export const versionFrame = (): Uint8Array => frame(StlinkCommand.GET_VERSION);
export const currentModeFrame = (): Uint8Array => frame(StlinkCommand.GET_CURRENT_MODE);
export const dfuExitFrame = (): Uint8Array => frame(StlinkCommand.DFU, DFU_EXIT);
export const swimExitFrame = (): Uint8Array => frame(StlinkCommand.SWIM, SWIM_EXIT);
export const targetVoltageFrame = (): Uint8Array => frame(StlinkCommand.GET_TARGET_VOLTAGE);
export const swdClockFrame = (divisor: number): Uint8Array => frame(StlinkCommand.DEBUG, DebugCommand.SWD_SET_FREQ, ...le16(divisor));
export const enterSwdFrame = (): Uint8Array => frame(StlinkCommand.DEBUG, DebugCommand.ENTER, ENTER_SWD_NO_RESET);
export const exitDebugFrame = (): Uint8Array => frame(StlinkCommand.DEBUG, DebugCommand.EXIT);
export const readIdcodesFrame = (): Uint8Array => frame(StlinkCommand.DEBUG, DebugCommand.READ_IDCODES);
export const lastRwStatusFrame = (): Uint8Array => frame(StlinkCommand.DEBUG, DebugCommand.GETLASTRWSTATUS2);

export const readMem32Frame = (address: number, length: number): Uint8Array =>
  frame(StlinkCommand.DEBUG, DebugCommand.READMEM_32BIT, ...le32(address), ...le16(length));

/** Must be followed by exactly `length` bytes of data on the OUT endpoint. */
export const writeMem32Frame = (address: number, length: number): Uint8Array =>
  frame(StlinkCommand.DEBUG, DebugCommand.WRITEMEM_32BIT, ...le32(address), ...le16(length));

export const writeDebugRegFrame = (address: number, value: number): Uint8Array =>
  frame(StlinkCommand.DEBUG, DebugCommand.WRITEDEBUGREG, ...le32(address), ...le32(value));

export const readDebugRegFrame = (address: number): Uint8Array => frame(StlinkCommand.DEBUG, DebugCommand.READDEBUGREG, ...le32(address));

/** A decoded GET_VERSION reply. */
export interface StlinkVersion {
  /** Hardware generation: 2 for V2 and V2-1. */
  stlink: number;
  /** JTAG/SWD firmware version, the "J" number. */
  jtag: number;
  /** SWIM firmware version ("S"), 0 on V2-1. */
  swim: number;
  /** Mass-storage firmware version ("M"), V2-1 only. */
  msd: number;
  vendorId: number;
  productId: number;
}

const V2_1_PRODUCT_IDS = new Set([0x374b, 0x3752]);

/**
 * Decodes the 6-byte GET_VERSION reply. The first two bytes are a big-endian word,
 * `stlink << 12 | jtag << 6 | low6`; the low field is the SWIM version on V2 and the
 * mass-storage version on V2-1. VID and PID follow, little-endian.
 */
export function parseVersion(reply: Uint8Array): StlinkVersion {
  if (reply.length < ReplyLength.VERSION) throw new RangeError(`Version reply is ${reply.length} bytes, expected ${ReplyLength.VERSION}`);
  const word = (reply[0]! << 8) | reply[1]!;
  const productId = readLe16(reply, 4);
  const low = word & 0x3f;
  const v21 = V2_1_PRODUCT_IDS.has(productId);
  return {
    stlink: (word >> 12) & 0x0f,
    jtag: (word >> 6) & 0x3f,
    swim: v21 ? 0 : low,
    msd: v21 ? low : 0,
    vendorId: readLe16(reply, 2),
    productId,
  };
}

/** The firmware name ST's tools show, for example "V2J39S7" or "V2J40M27". */
export function formatFirmware(version: StlinkVersion): string {
  const suffix = version.msd ? `M${version.msd}` : `S${version.swim}`;
  return `V${version.stlink}J${version.jtag}${suffix}`;
}

/**
 * Decodes the GET_TARGET_VOLTAGE reply: two ADC words, the internal 1.2 V reference and
 * half the target voltage. Undefined when the reference reads zero.
 */
export function parseTargetVoltage(reply: Uint8Array): number | undefined {
  const reference = readLe32(reply, 0);
  const measured = readLe32(reply, 4);
  if (!reference) return undefined;
  return Math.round(((2 * measured * 1.2) / reference) * 100) / 100;
}

export function parseCurrentMode(reply: Uint8Array): number {
  return reply[0]!;
}

/** Status byte and DP IDCODE from READ_IDCODES. */
export function parseIdcodes(reply: Uint8Array): { status: number; idcode: number } {
  return { status: reply[0]!, idcode: readLe32(reply, 4) };
}

/** Status byte and value from READDEBUGREG. */
export function parseDebugRegRead(reply: Uint8Array): { status: number; value: number } {
  return { status: reply[0]!, value: readLe32(reply, 4) };
}

/** Status byte and faulting address from GETLASTRWSTATUS2. */
export function parseRwStatus(reply: Uint8Array): { status: number; faultAddress: number } {
  return { status: reply[0]!, faultAddress: readLe32(reply, 4) };
}
