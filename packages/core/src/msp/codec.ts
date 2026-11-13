/** A decoded MSP frame. `error` is set when the firmware answered with the `!` direction. */
export interface MspFrame {
  version: 1 | 2;
  command: number;
  payload: Uint8Array;
  error: boolean;
}

const DOLLAR = 0x24;
const LETTER_M = 0x4d;
const LETTER_X = 0x58;
const DIR_REQUEST = 0x3c; // <
const DIR_RESPONSE = 0x3e; // >
const DIR_ERROR = 0x21; // !

const MAX_V1_COMMAND = 254;
const MAX_V1_PAYLOAD = 254;
const MAX_V2_PAYLOAD = 4096;

/** CRC-8/DVB-S2, the checksum used by MSP v2. */
export function crc8DvbS2(data: Uint8Array, seed = 0): number {
  let crc = seed;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function encodeV1(command: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  if (command > MAX_V1_COMMAND || payload.length > MAX_V1_PAYLOAD) {
    throw new RangeError(`MSP v1 cannot carry command ${command} with ${payload.length} bytes`);
  }
  const frame = new Uint8Array(6 + payload.length);
  frame.set([DOLLAR, LETTER_M, DIR_REQUEST, payload.length, command]);
  frame.set(payload, 5);
  let checksum = payload.length ^ command;
  for (const byte of payload) checksum ^= byte;
  frame[frame.length - 1] = checksum;
  return frame;
}

export function encodeV2(command: number, payload: Uint8Array = new Uint8Array(), flag = 0): Uint8Array {
  const frame = new Uint8Array(9 + payload.length);
  frame.set([DOLLAR, LETTER_X, DIR_REQUEST, flag, command & 0xff, command >> 8, payload.length & 0xff, payload.length >> 8]);
  frame.set(payload, 8);
  frame[frame.length - 1] = crc8DvbS2(frame.subarray(3, frame.length - 1));
  return frame;
}

/** Encodes a request with the oldest protocol version able to carry it. */
export function encodeRequest(command: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  return command > MAX_V1_COMMAND || payload.length > MAX_V1_PAYLOAD ? encodeV2(command, payload) : encodeV1(command, payload);
}

type DecoderState = "idle" | "marker" | "direction" | "v1-size" | "v1-command" | "v1-payload" | "v1-checksum" | "v2-header" | "v2-payload" | "v2-checksum";

/**
 * Streaming MSP decoder. Bytes outside a valid frame, and frames that fail their
 * checksum, are dropped and the decoder resynchronises on the next `$`.
 */
export class MspDecoder {
  private state: DecoderState = "idle";
  private version: 1 | 2 = 1;
  private error = false;
  private command = 0;
  private size = 0;
  private checksum = 0;
  private header = new Uint8Array(5);
  private headerIndex = 0;
  private payload = new Uint8Array();
  private payloadIndex = 0;

  /** Feeds bytes in and returns every frame they complete, in order. */
  push(chunk: Uint8Array): MspFrame[] {
    const frames: MspFrame[] = [];
    for (const byte of chunk) {
      const frame = this.consume(byte);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private consume(byte: number): MspFrame | undefined {
    switch (this.state) {
      case "idle":
        if (byte === DOLLAR) this.state = "marker";
        return undefined;
      case "marker":
        if (byte === LETTER_M || byte === LETTER_X) {
          this.version = byte === LETTER_M ? 1 : 2;
          this.state = "direction";
        } else {
          this.state = byte === DOLLAR ? "marker" : "idle";
        }
        return undefined;
      case "direction":
        if (byte === DIR_RESPONSE || byte === DIR_ERROR) {
          this.error = byte === DIR_ERROR;
          this.headerIndex = 0;
          this.state = this.version === 1 ? "v1-size" : "v2-header";
        } else {
          this.state = "idle";
        }
        return undefined;
      case "v1-size":
        this.size = byte;
        this.checksum = byte;
        this.state = "v1-command";
        return undefined;
      case "v1-command":
        this.command = byte;
        this.checksum ^= byte;
        this.beginPayload();
        this.state = this.size > 0 ? "v1-payload" : "v1-checksum";
        return undefined;
      case "v1-payload":
        this.checksum ^= byte;
        this.storePayloadByte(byte);
        if (this.payloadIndex === this.size) this.state = "v1-checksum";
        return undefined;
      case "v1-checksum":
        return this.finish(byte === this.checksum);
      case "v2-header":
        this.header[this.headerIndex++] = byte;
        if (this.headerIndex === 5) this.finishV2Header();
        return undefined;
      case "v2-payload":
        this.storePayloadByte(byte);
        if (this.payloadIndex === this.size) this.state = "v2-checksum";
        return undefined;
      case "v2-checksum": {
        const body = new Uint8Array(5 + this.size);
        body.set(this.header);
        body.set(this.payload, 5);
        return this.finish(crc8DvbS2(body) === byte);
      }
    }
  }

  private finishV2Header(): void {
    this.command = this.header[1]! | (this.header[2]! << 8);
    this.size = this.header[3]! | (this.header[4]! << 8);
    if (this.size > MAX_V2_PAYLOAD) {
      this.state = "idle";
      return;
    }
    this.beginPayload();
    this.state = this.size > 0 ? "v2-payload" : "v2-checksum";
  }

  private beginPayload(): void {
    this.payload = new Uint8Array(this.size);
    this.payloadIndex = 0;
  }

  private storePayloadByte(byte: number): void {
    this.payload[this.payloadIndex++] = byte;
  }

  private finish(valid: boolean): MspFrame | undefined {
    this.state = "idle";
    if (!valid) return undefined;
    return { version: this.version, command: this.command, payload: this.payload, error: this.error };
  }
}
