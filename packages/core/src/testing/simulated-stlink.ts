/**
 * An ST-Link/V2 (or V2-1) in software, in front of a {@link SimulatedG4}. It implements
 * UsbBulkDeviceLike and parses the same 16-byte command blocks the real probe does,
 * answering byte for byte: version `29 C7 83 04 48 37` (V2J39S7), status 0x80 OK,
 * 0x11 AP fault, 0x16 DP error, and so on. Replies are built here independently of
 * stlink/frames.ts, so the session's encoders and parsers are tested against it.
 */
import type { TimeSource } from "../swd/time.js";
import type { UsbBulkDeviceLike } from "../targets/stm32g4/session.js";
import { CORTEX_M4_DP_IDCODE, type SimulatedG4 } from "./simulated-g4.js";

export interface SimulatedStlinkOptions {
  /** 0x3748 (V2, default), 0x374B or 0x3752 (V2-1). */
  productId?: number;
  /** The 6-byte GET_VERSION reply. Defaults to V2J39S7 for V2 and V2J39M27 for V2-1, with this product ID. */
  versionReply?: Uint8Array;
  /** The probe's mode when opened: 0 DFU (default), 1 mass storage, 2 debug. */
  initialMode?: number;
  /** Target voltage reported. Default 3.27 V. */
  targetVolts?: number;
  /**
   * Added per USB transfer, for a demo that should feel like hardware. Slept in batches
   * of at least 4 ms. With 0 the probe still yields every 256 transfers.
   */
  latencyMs?: number;
  /** Every transfer fails, as if the cable were pulled, after this many command blocks. */
  usbLostAfterFrames?: number;
  /**
   * Replies stop arriving after this many command blocks: the next read waits forever,
   * as on a wedged probe, until the device is closed (which aborts it, as WebUSB does).
   */
  stallAfterFrames?: number;
  /** Keep a copy of every command block in {@link SimulatedStlink.frames}. */
  recordFrames?: boolean;
  time?: TimeSource;
}

const OK = 0x80;
const FAULT = 0x81;
const GET_IDCODE_ERROR = 0x09;
const AP_FAULT = 0x11;
const DP_ERROR = 0x16;
const MODE_DFU = 0x00;
const MODE_MASS = 0x01;
const MODE_DEBUG = 0x02;
/** The probe buffer limits one 32-bit transfer on full-speed probes. */
const PROBE_BUFFER = 6144;
const SWD_DIVISORS = new Set([0, 1, 2, 3, 7, 15, 31, 40, 79, 158, 265, 798]);
const LATENCY_BATCH_MS = 4;
const YIELD_EVERY = 256;

const V2_VERSION = [0x29, 0xc7]; // V2 J39 S7
const V2_1_VERSION = [0x29, 0xdb]; // V2 J39 M27

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function getLe32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function getLe16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** The address of word `index` of a transfer: the AP's auto-increment wraps inside each 1 KB block. */
function tarAddress(start: number, index: number): number {
  return ((start & ~0x3ff) | ((start + index * 4) & 0x3ff)) >>> 0;
}

function disconnected(): Error {
  return new DOMException("A transfer error has occurred.", "NetworkError");
}

export class SimulatedStlink implements UsbBulkDeviceLike {
  readonly vendorId = 0x0483;
  readonly productId: number;
  /** Command blocks received, when `recordFrames` is set. */
  readonly frames: Uint8Array[] = [];
  /** Set if anything drove the probe's RST pin (Alpha Migrate must not). */
  nrstDriven = false;

  private readonly time: TimeSource;
  private readonly outEndpoint: number;
  private readonly versionReply: Uint8Array;
  private readonly targetVolts: number;
  private readonly latencyMs: number;
  private readonly usbLostAfterFrames: number | undefined;
  private readonly stallAfterFrames: number | undefined;
  private readonly stalledReads: ((error: Error) => void)[] = [];
  private readonly recordFrames: boolean;

  private opened_ = false;
  private claimed = false;
  private lost = false;
  private frameCount = 0;
  private mode: number;
  private linkEpoch = -1;
  private reply: Uint8Array | undefined;
  private pendingWrite: { address: number; length: number } | undefined;
  private lastRw = { status: OK, faultAddress: 0 };
  private latencyDebt = 0;
  private transfers = 0;

  constructor(
    readonly chip: SimulatedG4,
    options: SimulatedStlinkOptions = {},
  ) {
    this.productId = options.productId ?? 0x3748;
    this.outEndpoint = this.productId === 0x3748 ? 2 : 1;
    const word = this.productId === 0x3748 ? V2_VERSION : V2_1_VERSION;
    this.versionReply = options.versionReply ?? Uint8Array.from([...word, 0x83, 0x04, this.productId & 0xff, this.productId >>> 8]);
    this.mode = options.initialMode ?? MODE_DFU;
    this.targetVolts = options.targetVolts ?? 3.27;
    this.latencyMs = options.latencyMs ?? 0;
    this.usbLostAfterFrames = options.usbLostAfterFrames;
    this.stallAfterFrames = options.stallAfterFrames;
    this.recordFrames = options.recordFrames ?? false;
    this.time = options.time ?? chip.time;
  }

  get opened(): boolean {
    return this.opened_;
  }

  async open(): Promise<void> {
    if (this.lost) throw disconnected();
    this.opened_ = true;
  }

  async close(): Promise<void> {
    this.opened_ = false;
    this.claimed = false;
    for (const abort of this.stalledReads.splice(0)) abort(new DOMException("The transfer was cancelled.", "AbortError"));
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    if (!this.opened_) throw new Error("SimulatedStlink: device not open");
    if (configurationValue !== 1) throw new Error(`SimulatedStlink: no configuration ${configurationValue}`);
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    if (!this.opened_) throw new Error("SimulatedStlink: device not open");
    if (interfaceNumber !== 0) throw new Error(`SimulatedStlink: no interface ${interfaceNumber}`);
    this.claimed = true;
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    if (interfaceNumber === 0) this.claimed = false;
  }

  async transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status?: string; bytesWritten?: number }> {
    await this.delay();
    this.checkUsable(endpointNumber, this.outEndpoint);
    if (this.pendingWrite) {
      const { address, length } = this.pendingWrite;
      this.pendingWrite = undefined;
      if (data.length !== length) throw new Error(`SimulatedStlink: data phase of ${data.length} bytes, expected ${length}`);
      this.writeMemory(address, data);
      return { status: "ok", bytesWritten: data.length };
    }
    if (data.length !== 16) throw new Error(`SimulatedStlink: command block of ${data.length} bytes, expected 16`);
    if (this.reply) throw new Error("SimulatedStlink: new command while a reply is still unread");
    this.frameCount++;
    if (this.usbLostAfterFrames !== undefined && this.frameCount > this.usbLostAfterFrames) {
      this.lost = true;
      throw disconnected();
    }
    if (this.recordFrames) this.frames.push(data.slice());
    this.handle(data);
    return { status: "ok", bytesWritten: data.length };
  }

  async transferIn(endpointNumber: number, length: number): Promise<{ status?: string; data?: DataView }> {
    await this.delay();
    this.checkUsable(endpointNumber, 1);
    if (this.stallAfterFrames !== undefined && this.frameCount > this.stallAfterFrames) {
      return new Promise((_, reject) => this.stalledReads.push(reject));
    }
    const reply = this.reply;
    if (!reply) throw new Error("SimulatedStlink: read with no reply pending (the real probe would hang)");
    this.reply = undefined;
    if (length < reply.length) return { status: "babble", data: new DataView(reply.buffer, 0, length) };
    return { status: "ok", data: new DataView(reply.buffer, 0, reply.length) };
  }

  private async delay(): Promise<void> {
    // Yield to the event loop now and then, so a page driving a long write can repaint.
    if (++this.transfers % YIELD_EVERY === 0 && this.latencyDebt < LATENCY_BATCH_MS) await this.time.sleep(0);
    if (this.latencyMs <= 0) return;
    this.latencyDebt += this.latencyMs;
    if (this.latencyDebt < LATENCY_BATCH_MS) return;
    const ms = this.latencyDebt;
    this.latencyDebt = 0;
    await this.time.sleep(ms);
  }

  private checkUsable(endpoint: number, expected: number): void {
    if (this.lost) throw disconnected();
    if (!this.opened_ || !this.claimed) throw new Error("SimulatedStlink: interface 0 is not claimed");
    if (endpoint !== expected) throw new Error(`SimulatedStlink: no bulk endpoint ${endpoint} in that direction (expected ${expected})`);
  }

  private answer(bytes: number[]): void {
    this.reply = Uint8Array.from(bytes);
  }

  /** The SWD link is up: entered, not reset since, and the chip's debug port answers. */
  private targetUp(): boolean {
    return this.mode === MODE_DEBUG && this.linkEpoch === this.chip.dpEpoch && this.chip.debugPortState() === "ok";
  }

  private handle(block: Uint8Array): void {
    switch (block[0]) {
      case 0xf1: // GET_VERSION
        this.reply = this.versionReply.slice();
        return;
      case 0xf5: // GET_CURRENT_MODE
        this.answer([this.mode, 0]);
        return;
      case 0xf3: // DFU
        if (block[1] === 0x07) {
          this.mode = MODE_MASS;
          return;
        }
        break;
      case 0xf4: // SWIM
        if (block[1] === 0x01) {
          this.mode = MODE_MASS;
          return;
        }
        break;
      case 0xf7: {
        // GET_TARGET_VOLTAGE: reference count, then half the target voltage on the same scale.
        const reference = 1600;
        this.answer([...le32(reference), ...le32(Math.round((this.targetVolts * reference) / 2.4))]);
        return;
      }
      case 0xf2:
        this.handleDebug(block);
        return;
    }
    throw new Error(`SimulatedStlink: unsupported command ${[...block.subarray(0, 2)].map((byte) => byte.toString(16)).join(" ")}`);
  }

  private handleDebug(block: Uint8Array): void {
    const address = getLe32(block, 2);
    switch (block[1]) {
      case 0x30: {
        // ENTER
        if (block[2] !== 0xa3) throw new Error("SimulatedStlink: only SWD (0xA3) is modelled");
        this.mode = MODE_DEBUG;
        if (this.chip.debugPortState() === "unwired") {
          this.linkEpoch = -1;
          this.answer([GET_IDCODE_ERROR, 0]);
        } else {
          this.linkEpoch = this.chip.dpEpoch;
          this.answer([OK, 0]);
        }
        return;
      }
      case 0x21: // EXIT
        this.mode = MODE_MASS;
        this.linkEpoch = -1;
        return;
      case 0x31: // READ_IDCODES
        if (this.targetUp()) this.answer([OK, 0, 0, 0, ...le32(CORTEX_M4_DP_IDCODE), 0, 0, 0, 0]);
        else this.answer([DP_ERROR, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        return;
      case 0x43: // SWD_SET_FREQ
        this.answer([SWD_DIVISORS.has(getLe16(block, 2)) ? OK : FAULT, 0]);
        return;
      case 0x01: // GETSTATUS: core running or halted
        this.answer([this.chip.halted ? 0x81 : 0x80, 0]);
        return;
      case 0x32: {
        // RESETSYS
        const up = this.targetUp();
        if (up) this.chip.systemReset();
        this.answer([up ? OK : DP_ERROR, 0]);
        return;
      }
      case 0x3c: // DRIVE_NRST: on clones the RST pin is not wired to an STM32's NRST.
        this.nrstDriven = true;
        this.answer([OK, 0]);
        return;
      case 0x35: {
        // WRITEDEBUGREG
        if (!this.targetUp()) return this.answer([DP_ERROR, 0]);
        this.answer([this.chip.write32(address, getLe32(block, 6)) ? OK : AP_FAULT, 0]);
        return;
      }
      case 0x36: {
        // READDEBUGREG
        if (!this.targetUp()) return this.answer([DP_ERROR, 0, 0, 0, 0, 0, 0, 0]);
        const value = this.chip.read32(address);
        this.answer(value === undefined ? [AP_FAULT, 0, 0, 0, 0, 0, 0, 0] : [OK, 0, 0, 0, ...le32(value)]);
        return;
      }
      case 0x07: {
        // READMEM_32BIT: the reply is the data alone; status comes from GETLASTRWSTATUS2.
        const length = getLe16(block, 6);
        this.reply = this.readMemory(address, length);
        return;
      }
      case 0x08: {
        // WRITEMEM_32BIT: the data phase follows on OUT.
        const length = getLe16(block, 6);
        this.pendingWrite = { address, length };
        return;
      }
      case 0x3e: // GETLASTRWSTATUS2
        this.answer([this.lastRw.status, 0, 0, 0, ...le32(this.lastRw.faultAddress), 0, 0, 0, 0]);
        return;
      case 0x3b: // GETLASTRWSTATUS
        this.answer([this.lastRw.status, 0]);
        return;
    }
    throw new Error(`SimulatedStlink: unsupported debug command 0x${block[1]!.toString(16)}`);
  }

  private readMemory(address: number, length: number): Uint8Array {
    const data = new Uint8Array(length);
    this.lastRw = { status: OK, faultAddress: 0 };
    if (address % 4 !== 0 || length % 4 !== 0 || length > PROBE_BUFFER) {
      this.lastRw = { status: FAULT, faultAddress: address };
      return data;
    }
    for (let index = 0; index < length / 4; index++) {
      if (!this.targetUp()) {
        this.lastRw = { status: DP_ERROR, faultAddress: 0 };
        break;
      }
      const at = tarAddress(address, index);
      const value = this.chip.read32(at);
      if (value === undefined) {
        this.lastRw = { status: AP_FAULT, faultAddress: at };
        break;
      }
      data.set(le32(value), index * 4);
    }
    return data;
  }

  private writeMemory(address: number, data: Uint8Array): void {
    this.lastRw = { status: OK, faultAddress: 0 };
    if (address % 4 !== 0 || data.length % 4 !== 0 || data.length > PROBE_BUFFER) {
      this.lastRw = { status: FAULT, faultAddress: address };
      return;
    }
    for (let index = 0; index < data.length / 4; index++) {
      if (!this.targetUp()) {
        this.lastRw = { status: DP_ERROR, faultAddress: 0 };
        return;
      }
      const at = tarAddress(address, index);
      if (!this.chip.write32(at, getLe32(data, index * 4))) {
        this.lastRw = { status: AP_FAULT, faultAddress: at };
        return;
      }
    }
  }
}
