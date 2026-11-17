/**
 * A CMSIS-DAP v2 probe in software, in front of a {@link SimulatedG4}. It implements
 * UsbBulkDeviceLike with a configuration the session has to search, and parses the
 * same command packets a real probe does. Replies are built here independently of
 * cmsis-dap/commands.ts, so the session's encoders and parsers are tested against it.
 *
 * The debug port is modelled as ADIv5 requires: nothing answers until a line reset
 * with the JTAG-to-SWD switch, then only an IDCODE read until one happens; AP accesses
 * need debug power; a FAULT sets a sticky error that fails every AP access until ABORT
 * clears it; TAR auto-increment wraps inside 1 KB. A chip reset that drops the debug
 * port (dpEpoch) needs a new line reset.
 */
import type { TimeSource } from "../swd/time.js";
import type { UsbBulkDeviceLike, UsbProbeConfigurationLike } from "../targets/stm32g4/session.js";
import { CORTEX_M4_DP_IDCODE, type SimulatedG4 } from "./simulated-g4.js";

export interface SimulatedCmsisDapOptions {
  /** Default 0x0483:0x5740, the Flipper Zero's DAP Link app. */
  vendorId?: number;
  productId?: number;
  /**
   * "dap" (default): CDC serial interfaces plus a CMSIS-DAP v2 interface, as the
   * Flipper's DAP Link app presents. "cdc-only": a USB serial device with the same IDs,
   * such as a Flipper without the app or a flight controller.
   */
  interfaces?: "dap" | "cdc-only";
  /** The CMSIS-DAP interface's string. Default "CMSIS-DAP v2"; null models a host that cannot read it. */
  interfaceName?: string | null;
  /** DAP packet size. Default 64, as on full-speed probes. */
  packetSize?: number;
  /** DAP_Info capabilities byte. Default 0x03 (SWD and JTAG). */
  capabilities?: number;
  /** Every transfer fails, as if the cable were pulled, after this many commands. */
  usbLostAfterCommands?: number;
  /** Replies stop arriving after this many commands, until the device is closed. */
  stallAfterCommands?: number;
  /** Keep a copy of every command in {@link SimulatedCmsisDap.commands}. */
  recordCommands?: boolean;
  time?: TimeSource;
}

const OUT_ENDPOINT = 3;
const IN_ENDPOINT = 4;
const DAP_INTERFACE = 2;

const ACK_OK = 1;
const ACK_FAULT = 4;
const ACK_NONE = 7;

const STICKYERR = 1 << 5;
const POWER_UP_REQUEST = 0x50000000;
const POWER_UP_ACK = 0xa0000000;
const STKERRCLR = 1 << 2;
const CSW_DEVICE_EN = 1 << 6;

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function getLe32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function infoText(text: string): number[] {
  return text === "" ? [0] : [text.length + 1, ...[...text].map((char) => char.charCodeAt(0)), 0];
}

function disconnected(): Error {
  return new DOMException("A transfer error has occurred.", "NetworkError");
}

/** The bits of an SWJ sequence, in the order they are clocked out. */
function bitsOf(data: Uint8Array, count: number): number[] {
  return Array.from({ length: count }, (_, index) => (data[index >> 3]! >> (index & 7)) & 1);
}

export class SimulatedCmsisDap implements UsbBulkDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName = "Simulated DAP";
  /** Commands received, when `recordCommands` is set. */
  readonly commands: Uint8Array[] = [];
  /** Set if anything asked the probe to drive the target's reset pin (Alpha Migrate must not). */
  nrstDriven = false;
  /** The SWD clock last set, in Hz. */
  clockHz = 0;

  private readonly time: TimeSource;
  private readonly packetSize: number;
  private readonly capabilities: number;
  private readonly dapPresent: boolean;
  private readonly interfaceName: string | null;
  private readonly usbLostAfterCommands: number | undefined;
  private readonly stallAfterCommands: number | undefined;
  private readonly recordCommands: boolean;
  private readonly stalledReads: ((error: Error) => void)[] = [];

  private opened_ = false;
  private claimed = false;
  private lost = false;
  private commandCount = 0;
  private reply: Uint8Array | undefined;
  private swdStarted = false;
  /** The JTAG-to-SWD switch has been clocked out since the probe started SWD. */
  private swdSelected = false;
  private linkEpoch = -1;
  private idcodeRead = false;
  private powerRequest = 0;
  private sticky = false;
  private select = 0;
  private csw = 0;
  private tar = 0;

  constructor(
    readonly chip: SimulatedG4,
    options: SimulatedCmsisDapOptions = {},
  ) {
    this.vendorId = options.vendorId ?? 0x0483;
    this.productId = options.productId ?? 0x5740;
    this.dapPresent = (options.interfaces ?? "dap") === "dap";
    this.interfaceName = options.interfaceName === undefined ? "CMSIS-DAP v2" : options.interfaceName;
    this.packetSize = options.packetSize ?? 64;
    this.capabilities = options.capabilities ?? 0x03;
    this.usbLostAfterCommands = options.usbLostAfterCommands;
    this.stallAfterCommands = options.stallAfterCommands;
    this.recordCommands = options.recordCommands ?? false;
    this.time = options.time ?? chip.time;
  }

  get opened(): boolean {
    return this.opened_;
  }

  get configuration(): UsbProbeConfigurationLike {
    const cdc = [
      { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0x02, interfaceName: null, endpoints: [{ endpointNumber: 1, direction: "in" as const, type: "interrupt" as const, packetSize: 8 }] }] },
      {
        interfaceNumber: 1,
        alternates: [
          {
            alternateSetting: 0,
            interfaceClass: 0x0a,
            interfaceName: null,
            endpoints: [
              { endpointNumber: 2, direction: "out" as const, type: "bulk" as const, packetSize: 64 },
              { endpointNumber: 2, direction: "in" as const, type: "bulk" as const, packetSize: 64 },
            ],
          },
        ],
      },
    ];
    if (!this.dapPresent) return { interfaces: cdc };
    return {
      interfaces: [
        ...cdc,
        {
          interfaceNumber: DAP_INTERFACE,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 0xff,
              interfaceName: this.interfaceName,
              endpoints: [
                { endpointNumber: OUT_ENDPOINT, direction: "out", type: "bulk", packetSize: 64 },
                { endpointNumber: IN_ENDPOINT, direction: "in", type: "bulk", packetSize: 64 },
              ],
            },
          ],
        },
      ],
    };
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
    if (!this.opened_) throw new Error("SimulatedCmsisDap: device not open");
    if (configurationValue !== 1) throw new Error(`SimulatedCmsisDap: no configuration ${configurationValue}`);
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    if (!this.opened_) throw new Error("SimulatedCmsisDap: device not open");
    if (!this.dapPresent || interfaceNumber !== DAP_INTERFACE) throw new Error(`SimulatedCmsisDap: interface ${interfaceNumber} is not the CMSIS-DAP interface`);
    this.claimed = true;
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    if (interfaceNumber === DAP_INTERFACE) this.claimed = false;
  }

  async transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status?: string; bytesWritten?: number }> {
    await this.time.sleep(0);
    this.checkUsable(endpointNumber, OUT_ENDPOINT);
    if (data.length === 0 || data.length > this.packetSize) throw new Error(`SimulatedCmsisDap: a ${data.length}-byte command does not fit a ${this.packetSize}-byte packet`);
    if (this.reply) throw new Error("SimulatedCmsisDap: new command while a reply is still unread");
    this.commandCount++;
    if (this.usbLostAfterCommands !== undefined && this.commandCount > this.usbLostAfterCommands) {
      this.lost = true;
      throw disconnected();
    }
    if (this.recordCommands) this.commands.push(data.slice());
    this.reply = Uint8Array.from(this.handle(data));
    if (this.reply.length > this.packetSize) throw new Error(`SimulatedCmsisDap: a ${this.reply.length}-byte reply does not fit a ${this.packetSize}-byte packet`);
    return { status: "ok", bytesWritten: data.length };
  }

  async transferIn(endpointNumber: number, length: number): Promise<{ status?: string; data?: DataView }> {
    await this.time.sleep(0);
    this.checkUsable(endpointNumber, IN_ENDPOINT);
    if (this.stallAfterCommands !== undefined && this.commandCount > this.stallAfterCommands) {
      return new Promise((_, reject) => this.stalledReads.push(reject));
    }
    const reply = this.reply;
    if (!reply) throw new Error("SimulatedCmsisDap: read with no reply pending (the real probe would hang)");
    this.reply = undefined;
    if (length < reply.length) return { status: "babble", data: new DataView(reply.buffer, 0, length) };
    return { status: "ok", data: new DataView(reply.buffer, 0, reply.length) };
  }

  private checkUsable(endpoint: number, expected: number): void {
    if (this.lost) throw disconnected();
    if (!this.opened_ || !this.claimed) throw new Error("SimulatedCmsisDap: the CMSIS-DAP interface is not claimed");
    if (endpoint !== expected) throw new Error(`SimulatedCmsisDap: no bulk endpoint ${endpoint} in that direction (expected ${expected})`);
  }

  private handle(command: Uint8Array): number[] {
    const id = command[0]!;
    switch (id) {
      case 0x00:
        return [0x00, ...this.info(command[1]!)];
      case 0x01: // DAP_HostStatus
        return [0x01, 0x00];
      case 0x02: {
        // DAP_Connect: 0 means the default port, SWD here.
        const port = command[1]!;
        const started = port === 0 || port === 1 ? 1 : 0;
        this.swdStarted = started === 1;
        this.swdSelected = false;
        this.linkEpoch = -1;
        return [0x02, started];
      }
      case 0x03:
        this.swdStarted = false;
        this.linkEpoch = -1;
        return [0x03, 0x00];
      case 0x04: // DAP_TransferConfigure
        return [0x04, command.length === 6 ? 0x00 : 0xff];
      case 0x05:
        return this.transfer(command);
      case 0x0a: // DAP_ResetTarget
        this.nrstDriven = true;
        return [0x0a, 0x00, 0x00];
      case 0x10: // DAP_SWJ_Pins: bit 7 of the select mask is nRESET.
        if ((command[2]! & 0x80) !== 0) this.nrstDriven = true;
        return [0x10, 0x00];
      case 0x11:
        this.clockHz = getLe32(command, 1);
        return [0x11, this.clockHz > 0 ? 0x00 : 0xff];
      case 0x12:
        this.sequence(command);
        return [0x12, 0x00];
      case 0x13: // DAP_SWD_Configure
        return [0x13, command[1] === 0 ? 0x00 : 0xff];
    }
    throw new Error(`SimulatedCmsisDap: unsupported command 0x${id.toString(16)}`);
  }

  private info(id: number): number[] {
    switch (id) {
      case 0x01:
        return infoText("Simulated");
      case 0x02:
        return infoText("CMSIS-DAP");
      case 0x03:
        return infoText("SIM0001");
      case 0x04:
        return infoText("2.0.0");
      case 0x09:
        return infoText("");
      case 0xf0:
        return [1, this.capabilities];
      case 0xfe:
        return [1, 1];
      case 0xff:
        return [2, ...le16(this.packetSize)];
    }
    return [0];
  }

  /** DAP_SWJ_Sequence: 50 or more ones reset the line; 0xE79E after a reset selects SWD. */
  private sequence(command: Uint8Array): void {
    const count = command[1]! === 0 ? 256 : command[1]!;
    const bits = bitsOf(command.subarray(2), count);
    let ones = 0;
    for (let index = 0; index < bits.length; index++) {
      if (bits[index] === 1) {
        if (++ones === 50) this.lineReset();
        continue;
      }
      // The first zero after a line reset may start the 16-bit select, sent LSB first.
      if (ones >= 50 && index + 16 <= bits.length) {
        let word = 0;
        for (let bit = 0; bit < 16; bit++) word |= bits[index + bit]! << bit;
        if (word === 0xe79e) {
          this.swdSelected = true;
          index += 15;
        }
      }
      ones = 0;
    }
  }

  private lineReset(): void {
    this.idcodeRead = false;
    this.linkEpoch = this.swdStarted && this.chip.debugPortState() === "ok" ? this.chip.dpEpoch : -1;
  }

  /** The SWD link is up: SWD selected, reset since the chip last dropped its port, and the port answers. */
  private targetUp(): boolean {
    return this.swdStarted && this.swdSelected && this.linkEpoch === this.chip.dpEpoch && this.chip.debugPortState() === "ok";
  }

  private transfer(command: Uint8Array): number[] {
    const count = command[2]!;
    const data: number[] = [];
    let offset = 3;
    let done = 0;
    let response = ACK_OK;
    for (; done < count; done++) {
      const request = command[offset++]!;
      const read = (request & 0x02) !== 0;
      let value = 0;
      if (!read) {
        value = getLe32(command, offset);
        offset += 4;
      }
      if ((request & 0x30) !== 0) throw new Error("SimulatedCmsisDap: value match is not modelled");
      const result = this.access(request, value);
      if (result.ack !== ACK_OK) {
        response = result.ack;
        break;
      }
      if (read) data.push(...le32(result.value));
    }
    return [0x05, done, response, ...data];
  }

  private access(request: number, value: number): { ack: number; value: number } {
    const ap = (request & 0x01) !== 0;
    const read = (request & 0x02) !== 0;
    const address = request & 0x0c;
    if (!this.targetUp()) return { ack: ACK_NONE, value: 0 };
    // After a line reset the port answers nothing but an IDCODE read.
    if (!this.idcodeRead && !(!ap && read && address === 0)) return { ack: ACK_NONE, value: 0 };
    if (!ap) return this.dpAccess(read, address, value);

    if (this.sticky) return { ack: ACK_FAULT, value: 0 };
    if ((this.powerRequest & POWER_UP_REQUEST) !== POWER_UP_REQUEST || this.select !== 0) return this.fault();
    switch (address) {
      case 0x0:
        if (read) return { ack: ACK_OK, value: (this.csw | CSW_DEVICE_EN) >>> 0 };
        this.csw = value;
        return { ack: ACK_OK, value: 0 };
      case 0x4:
        if (read) return { ack: ACK_OK, value: this.tar };
        this.tar = value >>> 0;
        return { ack: ACK_OK, value: 0 };
      case 0xc: {
        if ((this.csw & 0x7) !== 0x2) return this.fault();
        const at = this.tar;
        if (read) {
          const word = this.chip.read32(at);
          if (word === undefined) return this.fault();
          this.advance();
          return { ack: ACK_OK, value: word };
        }
        if (!this.chip.write32(at, value)) return this.fault();
        this.advance();
        return { ack: ACK_OK, value: 0 };
      }
    }
    return { ack: ACK_OK, value: 0 };
  }

  private dpAccess(read: boolean, address: number, value: number): { ack: number; value: number } {
    if (read) {
      switch (address) {
        case 0x0:
          this.idcodeRead = true;
          return { ack: ACK_OK, value: CORTEX_M4_DP_IDCODE };
        case 0x4: {
          const acks = (this.powerRequest & POWER_UP_REQUEST) === POWER_UP_REQUEST ? POWER_UP_ACK : 0;
          return { ack: ACK_OK, value: (this.powerRequest | acks | (this.sticky ? STICKYERR : 0)) >>> 0 };
        }
        default:
          return { ack: ACK_OK, value: 0 };
      }
    }
    switch (address) {
      case 0x0:
        if ((value & STKERRCLR) !== 0) this.sticky = false;
        break;
      case 0x4:
        this.powerRequest = value & POWER_UP_REQUEST;
        break;
      case 0x8:
        this.select = value >>> 0;
        break;
    }
    return { ack: ACK_OK, value: 0 };
  }

  private fault(): { ack: number; value: number } {
    this.sticky = true;
    return { ack: ACK_FAULT, value: 0 };
  }

  /** TAR auto-increment for 32-bit accesses, wrapping inside the 1 KB block. */
  private advance(): void {
    if (((this.csw >>> 4) & 0x3) !== 0x1) return;
    this.tar = ((this.tar & ~0x3ff) | ((this.tar + 4) & 0x3ff)) >>> 0;
  }
}
