import { crc8DvbS2 } from "../msp/codec.js";
import { MspCode, MspTextType } from "../msp/codes.js";
import { TransportEvents, type ByteTransport, type CloseReason, type Unsubscribe } from "../transport.js";

/** Captured data that a {@link SimulatedFc} replays. All hex values come from real boards. */
export interface SimulatedFcProfile {
  apiVersionHex: string;
  variant: string;
  firmwareVersionHex: string;
  boardInfoHex: string;
  buildInfoHex: string;
  uidHex: string;
  craftName: string;
  buildKey?: string;
  /** CLI command to the text it prints. */
  cli: Record<string, string>;
}

const encoder = new TextEncoder();

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

type Mode = "msp" | "cli";

/** Removes the echoed command and trailing prompt from a raw capture of CLI output. */
export function cleanCapturedCli(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  lines.shift();
  while (lines.length > 0 && /^(# ?)?$/.test(lines[lines.length - 1]!)) lines.pop();
  return lines.join("\n");
}

/**
 * A flight controller in software: answers MSP identity queries and replays
 * captured CLI output. Backs unit tests and the app's demo mode.
 */
export class SimulatedFc implements ByteTransport {
  private readonly events = new TransportEvents();
  private open_ = false;
  private mode: Mode = "msp";
  private lineBuffer = "";
  private mspBuffer: number[] = [];
  private readonly values = new Map<string, string>();
  /** Every complete CLI line received, for assertions. */
  readonly receivedLines: string[] = [];
  rebootCount = 0;

  constructor(
    private readonly profile: SimulatedFcProfile,
    private readonly options: { startInCli?: boolean; latencyMs?: number; rejectedSettings?: readonly string[] } = {},
  ) {
    if (options.startInCli) this.mode = "cli";
  }

  get isOpen(): boolean {
    return this.open_;
  }

  async open(): Promise<void> {
    this.open_ = true;
  }

  async close(): Promise<void> {
    if (!this.open_) return;
    this.open_ = false;
    this.events.emitClose("requested");
  }

  onData(listener: (chunk: Uint8Array) => void): Unsubscribe {
    return this.events.onData(listener);
  }

  onClose(listener: (reason: CloseReason) => void): Unsubscribe {
    return this.events.onClose(listener);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.open_) throw new Error("Simulated port is closed");
    for (const byte of data) {
      const wasMsp = this.mode === "msp";
      this.consume(byte);
      // Real firmware discards the rest of the read pass that switched it into CLI mode.
      if (wasMsp && this.mode === "cli") return;
    }
  }

  private emit(bytes: Uint8Array): void {
    const deliver = () => {
      if (this.open_) this.events.emitData(bytes);
    };
    if (this.options.latencyMs) setTimeout(deliver, this.options.latencyMs);
    else queueMicrotask(deliver);
  }

  private emitText(text: string): void {
    this.emit(encoder.encode(text));
  }

  private consume(byte: number): void {
    if (this.mode === "cli") {
      this.consumeCli(byte);
      return;
    }
    if (this.mspBuffer.length === 0 && byte === 0x23) {
      this.mode = "cli";
      this.lineBuffer = "";
      this.emitText("\r\nEntering CLI Mode, type 'exit' to return, or 'help'\r\n# ");
      return;
    }
    this.mspBuffer.push(byte);
    this.tryHandleMsp();
  }

  private tryHandleMsp(): void {
    const buffer = this.mspBuffer;
    if (buffer[0] !== 0x24) {
      this.mspBuffer = [];
      return;
    }
    if (buffer.length < 5) return;
    if (buffer[1] === 0x4d) {
      const size = buffer[3]!;
      if (buffer.length < 6 + size) return;
      const payload = Uint8Array.from(buffer.slice(5, 5 + size));
      const command = buffer[4]!;
      this.mspBuffer = [];
      this.reply(1, command, payload);
      return;
    }
    if (buffer.length < 8) return;
    const size = buffer[6]! | (buffer[7]! << 8);
    if (buffer.length < 9 + size) return;
    const command = buffer[4]! | (buffer[5]! << 8);
    const payload = Uint8Array.from(buffer.slice(8, 8 + size));
    this.mspBuffer = [];
    this.reply(2, command, payload);
  }

  private reply(version: 1 | 2, command: number, request: Uint8Array): void {
    const payload = this.answer(command, request);
    this.emit(version === 1 ? this.frameV1(command, payload) : this.frameV2(command, payload));
  }

  private answer(command: number, request: Uint8Array): Uint8Array | undefined {
    switch (command) {
      case MspCode.API_VERSION:
        return fromHex(this.profile.apiVersionHex);
      case MspCode.FC_VARIANT:
        return encoder.encode(this.profile.variant);
      case MspCode.FC_VERSION:
        return fromHex(this.profile.firmwareVersionHex);
      case MspCode.BOARD_INFO:
        return fromHex(this.profile.boardInfoHex);
      case MspCode.BUILD_INFO:
        return fromHex(this.profile.buildInfoHex);
      case MspCode.UID:
        return fromHex(this.profile.uidHex);
      case MspCode.NAME:
        return encoder.encode(this.profile.craftName);
      case MspCode.GET_TEXT:
        return this.answerText(request[0] ?? 0);
      default:
        return undefined;
    }
  }

  private answerText(type: number): Uint8Array | undefined {
    const text = type === MspTextType.CRAFT_NAME ? this.profile.craftName : type === MspTextType.BUILD_KEY ? this.profile.buildKey : undefined;
    if (text === undefined) return undefined;
    return Uint8Array.of(type, text.length, ...encoder.encode(text));
  }

  private frameV1(command: number, payload: Uint8Array | undefined): Uint8Array {
    const body = payload ?? new Uint8Array();
    const frame = new Uint8Array(6 + body.length);
    frame.set([0x24, 0x4d, payload ? 0x3e : 0x21, body.length, command]);
    frame.set(body, 5);
    let checksum = body.length ^ command;
    for (const byte of body) checksum ^= byte;
    frame[frame.length - 1] = checksum;
    return frame;
  }

  private frameV2(command: number, payload: Uint8Array | undefined): Uint8Array {
    const body = payload ?? new Uint8Array();
    const frame = new Uint8Array(9 + body.length);
    frame.set([0x24, 0x58, payload ? 0x3e : 0x21, 0, command & 0xff, command >> 8, body.length & 0xff, body.length >> 8]);
    frame.set(body, 8);
    frame[frame.length - 1] = crc8DvbS2(frame.subarray(3, frame.length - 1));
    return frame;
  }

  private consumeCli(byte: number): void {
    if (byte !== 0x0d && byte !== 0x0a) {
      this.lineBuffer += String.fromCharCode(byte);
      this.emit(Uint8Array.of(byte));
      return;
    }
    if (byte === 0x0a) return;

    const received = this.lineBuffer;
    this.lineBuffer = "";
    this.receivedLines.push(received);
    const line = (received.split("#")[0] ?? "").trim();
    const output = line ? this.runCommand(line) : "";
    if (output === null) return;
    this.emitText(`\r\n${output ? `${output.replace(/\n/g, "\r\n")}\r\n` : ""}# `);
  }

  private runCommand(line: string): string | null {
    const lowered = line.toLowerCase();
    if (lowered === "exit" || lowered === "save" || lowered === "defaults") {
      this.reboot();
      return null;
    }
    const set = /^set\s+(\S+)\s*=\s*(.*)$/i.exec(line);
    if (set) {
      if (this.options.rejectedSettings?.includes(set[1]!)) return `###ERROR IN set: INVALID NAME: ${set[1]}###`;
      this.values.set(set[1]!, set[2]!);
      return `${set[1]} set to ${set[2]}`;
    }
    if (/^(batch (start|end)|defaults nosave|(rate)?profile \d+|simplified_tuning apply)$/.test(lowered)) return "";
    return this.profile.cli[lowered] ?? `###ERROR IN ${line.split(/\s+/)[0]}: UNKNOWN COMMAND, TRY 'HELP'###`;
  }

  private reboot(): void {
    this.rebootCount += 1;
    this.mode = "msp";
    this.lineBuffer = "";
    this.emitText("\r\nRebooting");
  }
}
