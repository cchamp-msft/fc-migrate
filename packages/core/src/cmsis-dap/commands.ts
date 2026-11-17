/**
 * CMSIS-DAP command packets and their replies, for the v2 (bulk endpoint) transport.
 * Only what Alpha Migrate needs: probe information, starting SWD, the clock, SWD line
 * sequences, and DP/AP register transfers. Reply checks that need the probe's state
 * live in probe.ts; these functions only build and take apart bytes.
 *
 * DAP_ResetTarget and DAP_SWJ_Pins are left out on purpose: the probe's reset pin is
 * never used, and nothing here can drive it.
 *
 * Reference: Arm CMSIS-DAP documentation, "Commands" (General, Transfer and SWD).
 */

export const DapCommand = {
  INFO: 0x00,
  CONNECT: 0x02,
  DISCONNECT: 0x03,
  TRANSFER_CONFIGURE: 0x04,
  TRANSFER: 0x05,
  SWJ_CLOCK: 0x11,
  SWJ_SEQUENCE: 0x12,
  SWD_CONFIGURE: 0x13,
} as const;

/** DAP_Info identifiers. */
export const DapInfo = {
  VENDOR: 0x01,
  PRODUCT: 0x02,
  /** The CMSIS-DAP protocol version the firmware implements, such as "2.0.0". */
  PROTOCOL_VERSION: 0x04,
  /** The product's own firmware version. CMSIS-DAP 2.1 and later; older probes answer with nothing. */
  PRODUCT_FIRMWARE: 0x09,
  CAPABILITIES: 0xf0,
  PACKET_SIZE: 0xff,
} as const;

/** DAP_OK in a one-byte status reply. Anything else (DAP_ERROR is 0xFF) is a refusal. */
export const DAP_OK = 0x00;
/** DAP_Connect port: SWD. The reply echoes the port started, or 0 when it failed. */
export const PORT_SWD = 1;
/** DAP_Info capabilities, byte 0, bit 0: SWD supported. */
export const CAPABILITY_SWD = 0x01;

/** Acknowledgements in bits 2:0 of a DAP_Transfer response byte. */
export const Ack = { OK: 1, WAIT: 2, FAULT: 4, NO_ACK: 7 } as const;
/** DAP_Transfer response bit 3: the SWD data phase had a parity error. */
export const RESPONSE_PROTOCOL_ERROR = 0x08;
/** DAP_Transfer response bit 4: a value-match read did not match. Never requested here. */
export const RESPONSE_VALUE_MISMATCH = 0x10;

/** Debug port registers, by address bits A[3:2]. IDCODE is read at 0x0; ABORT is written there. */
export const DpRegister = { IDCODE: 0x0, ABORT: 0x0, CTRL_STAT: 0x4, SELECT: 0x8, RDBUFF: 0xc } as const;
/** MEM-AP registers in bank 0, the only bank used: SELECT stays 0 (AP 0, the AHB-AP). */
export const ApRegister = { CSW: 0x0, TAR: 0x4, DRW: 0xc } as const;

/** ABORT: clear the sticky compare, error, write-data and overrun flags. */
export const ABORT_CLEAR_STICKY = 0x1e;
/** ABORT: DAPABORT, which also ends a transfer the AP keeps answering WAIT to. */
export const ABORT_DAPABORT = 0x01;
/** CTRL/STAT: CSYSPWRUPREQ | CDBGPWRUPREQ. */
export const CTRL_STAT_POWER_UP_REQUEST = 0x50000000;
/** CTRL/STAT: CSYSPWRUPACK | CDBGPWRUPACK. */
export const CTRL_STAT_POWER_UP_ACK = 0xa0000000;
/**
 * CSW for the Cortex-M AHB-AP: 32-bit accesses, TAR increments after each, debugger
 * master, privileged data access (HPROT). The value pyOCD and DAPLink write.
 */
export const CSW_WORD_INCREMENT = 0x23000052;

/**
 * At least 50 ones (a line reset), the 16-bit JTAG-to-SWD select 0xE79E sent LSB
 * first, another line reset, then idle cycles. Works whether the port was in JTAG or
 * already in SWD. 136 bits.
 */
export const SWD_LINE_RESET = { bits: 136, data: Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x9e, 0xe7, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]) } as const;

/** One DP or AP register access in a DAP_Transfer. A transfer with `value` writes; one without reads. */
export interface RegisterTransfer {
  ap: boolean;
  /** Register address; only bits 3:2 are sent. */
  register: number;
  value?: number;
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function getLe32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

export function infoFrame(id: number): Uint8Array {
  return Uint8Array.from([DapCommand.INFO, id]);
}

export function connectFrame(port: number): Uint8Array {
  return Uint8Array.from([DapCommand.CONNECT, port]);
}

export function disconnectFrame(): Uint8Array {
  return Uint8Array.from([DapCommand.DISCONNECT]);
}

export function swjClockFrame(hz: number): Uint8Array {
  return Uint8Array.from([DapCommand.SWJ_CLOCK, ...le32(hz)]);
}

/** Idle cycles after each transfer, how often a WAIT is retried, and how often a value-match read is retried. */
export function transferConfigureFrame(idleCycles: number, waitRetries: number, matchRetries: number): Uint8Array {
  return Uint8Array.from([DapCommand.TRANSFER_CONFIGURE, idleCycles, ...le16(waitRetries), ...le16(matchRetries)]);
}

/** 0: one turnaround cycle, and no data phase on a WAIT or FAULT. The SWD defaults. */
export function swdConfigureFrame(configuration: number): Uint8Array {
  return Uint8Array.from([DapCommand.SWD_CONFIGURE, configuration]);
}

/** Clocks out `bits` bits of `data` on SWDIO, LSB first. 1 to 256 bits; 256 is sent as 0. */
export function swjSequenceFrame(bits: number, data: Uint8Array): Uint8Array {
  if (bits < 1 || bits > 256 || data.length !== Math.ceil(bits / 8)) throw new RangeError(`An SWJ sequence of ${bits} bits needs ${Math.ceil(bits / 8)} bytes, not ${data.length}`);
  return Uint8Array.from([DapCommand.SWJ_SEQUENCE, bits & 0xff, ...data]);
}

/** The request byte: bit 0 APnDP, bit 1 RnW, bits 3:2 the register address. */
export function requestByte(transfer: RegisterTransfer): number {
  return (transfer.ap ? 1 : 0) | (transfer.value === undefined ? 2 : 0) | (transfer.register & 0x0c);
}

/** DAP_Transfer on DAP index 0 (ignored for SWD). At most 255 transfers. */
export function transferFrame(transfers: readonly RegisterTransfer[]): Uint8Array {
  if (transfers.length < 1 || transfers.length > 255) throw new RangeError(`A DAP_Transfer holds 1 to 255 transfers, not ${transfers.length}`);
  const bytes = [DapCommand.TRANSFER, 0, transfers.length];
  for (const transfer of transfers) {
    bytes.push(requestByte(transfer));
    if (transfer.value !== undefined) bytes.push(...le32(transfer.value >>> 0));
  }
  return Uint8Array.from(bytes);
}

/** Bytes a DAP_Transfer command and its reply take. */
export function transferSizes(transfers: readonly RegisterTransfer[]): { command: number; reply: number } {
  const writes = transfers.filter((transfer) => transfer.value !== undefined).length;
  const reads = transfers.length - writes;
  return { command: 3 + transfers.length + 4 * writes, reply: 3 + 4 * reads };
}

export interface TransferReply {
  /** Transfers the probe completed. */
  count: number;
  /** The response byte of the last transfer attempted. */
  response: number;
  /** Bytes after the response byte: the read values, four bytes each. */
  data: Uint8Array;
}

/** Takes apart a DAP_Transfer reply. Undefined when it is not one. */
export function parseTransferReply(reply: Uint8Array): TransferReply | undefined {
  if (reply.length < 3 || reply[0] !== DapCommand.TRANSFER) return undefined;
  return { count: reply[1]!, response: reply[2]!, data: reply.subarray(3) };
}

/** True when every transfer completed with an OK acknowledgement. */
export function transferSucceeded(reply: TransferReply, requested: number): boolean {
  return reply.count === requested && reply.response === Ack.OK;
}

/** The read values of a fully successful transfer. */
export function readValues(reply: TransferReply, reads: number): number[] {
  if (reply.data.length < reads * 4) throw new RangeError(`The DAP_Transfer reply holds ${reply.data.length} data bytes, not ${reads * 4}`);
  return Array.from({ length: reads }, (_, index) => getLe32(reply.data, index * 4));
}

/** Names a failed transfer's response for messages. */
export function responseName(response: number): string {
  if (response & RESPONSE_PROTOCOL_ERROR) return "SWD parity error";
  if (response & RESPONSE_VALUE_MISMATCH) return "value mismatch";
  switch (response & 0x07) {
    case Ack.OK:
      return "OK";
    case Ack.WAIT:
      return "WAIT";
    case Ack.FAULT:
      return "FAULT";
    case Ack.NO_ACK:
      return "no answer";
    default:
      return `response 0x${response.toString(16).padStart(2, "0")}`;
  }
}

/** The data of a DAP_Info reply. Undefined when it is not one. */
export function parseInfoReply(reply: Uint8Array): Uint8Array | undefined {
  if (reply.length < 2 || reply[0] !== DapCommand.INFO) return undefined;
  const length = reply[1]!;
  if (reply.length < 2 + length) return undefined;
  return reply.subarray(2, 2 + length);
}

/** A DAP_Info string: ASCII, NUL-terminated, empty when the probe has none. */
export function infoString(data: Uint8Array): string {
  const end = data.indexOf(0);
  return String.fromCharCode(...(end < 0 ? data : data.subarray(0, end))).trim();
}

/** A one-byte status reply (DAP_OK or DAP_ERROR) to `command`. Undefined when it is not one. */
export function parseStatusReply(reply: Uint8Array, command: number): number | undefined {
  if (reply.length < 2 || reply[0] !== command) return undefined;
  return reply[1];
}
