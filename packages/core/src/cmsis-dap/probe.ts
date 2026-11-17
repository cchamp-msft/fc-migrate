/**
 * One open CMSIS-DAP v2 probe: finding its bulk interface, starting SWD, powering up
 * the debug port, and 32-bit memory access through the AHB-AP. Commands are
 * serialised, so one command and its reply can never interleave with another's.
 *
 * Every memory access is a single DAP_Transfer that sets TAR and then reads or writes
 * DRW, so no state carries between commands except SELECT (always 0) and CSW (set when
 * SWD starts). The probe firmware handles the AP's posted reads.
 */
import { MemoryAccessError, hex32, type MemoryAccess } from "../swd/memory-access.js";
import { pollUntil, realTime, type TimeSource } from "../swd/time.js";
import { SessionError, type ProbeInfo, type UsbProbeAlternateLike, type UsbBulkDeviceLike } from "../targets/stm32g4/session.js";
import {
  ABORT_CLEAR_STICKY,
  ABORT_DAPABORT,
  Ack,
  ApRegister,
  CAPABILITY_SWD,
  CSW_WORD_INCREMENT,
  CTRL_STAT_POWER_UP_ACK,
  CTRL_STAT_POWER_UP_REQUEST,
  DAP_OK,
  DapInfo,
  DpRegister,
  PORT_SWD,
  SWD_LINE_RESET,
  connectFrame,
  disconnectFrame,
  infoFrame,
  infoString,
  parseInfoReply,
  parseStatusReply,
  parseTransferReply,
  readValues,
  responseName,
  swdConfigureFrame,
  swjClockFrame,
  swjSequenceFrame,
  transferConfigureFrame,
  transferFrame,
  transferSizes,
  transferSucceeded,
  type RegisterTransfer,
} from "./commands.js";
import { CMSIS_DAP_DEFAULT_CLOCK_KHZ } from "./models.js";

/** Real-time limit for one USB transfer. The probe answers in milliseconds when healthy. */
const DEFAULT_TRANSFER_TIMEOUT_MS = 3000;
/** Memory transfers never cross this boundary: the AP's address auto-increment may wrap there. */
const TAR_WINDOW = 1024;
const CONFIGURATION = 1;
const VENDOR_CLASS = 0xff;
/** Starting SWD is retried this often, briefly, because the first try after a target reset can fail. */
const ENTER_ATTEMPTS = 3;
const ENTER_RETRY_MS = 100;
/** How long the debug port has to acknowledge the power-up request. */
const POWER_UP_TIMEOUT_MS = 100;
/** WAIT answers the probe firmware retries before reporting one. */
const WAIT_RETRIES = 100;
/** The smallest DAP packet size accepted: full-speed probes report 64. */
const MIN_PACKET_SIZE = 64;
/** Larger packets gain nothing here, and a reply buffer this size is always enough. */
const MAX_PACKET_SIZE = 1024;

export interface CmsisDapProbeOptions {
  /** SWD clock. Default {@link CMSIS_DAP_DEFAULT_CLOCK_KHZ}. */
  clockKhz?: number;
  time?: TimeSource;
  /** Real-time limit for one USB transfer. Default 3 s. A timeout makes the probe unusable. */
  transferTimeoutMs?: number;
}

/** Where the probe's CMSIS-DAP v2 interface is. */
export interface DapInterface {
  interfaceNumber: number;
  outEndpoint: number;
  inEndpoint: number;
  /** wMaxPacketSize of the IN endpoint. */
  inPacketSize: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usbError(action: string, error?: unknown): SessionError {
  const reason = error === undefined ? "" : `: ${describe(error)}`;
  const failure = new SessionError("usb", `${action}${reason}`);
  if (error !== undefined) failure.cause = error;
  return failure;
}

function checkAligned(address: number, length = 4): void {
  if (address % 4 !== 0 || length % 4 !== 0) throw new RangeError(`32-bit access needs 4-byte alignment: ${hex32(address)} + ${length}`);
}

function usbId(device: UsbBulkDeviceLike): string {
  return `${device.vendorId.toString(16).padStart(4, "0")}:${device.productId.toString(16).padStart(4, "0")}`;
}

function bulkPair(alternate: UsbProbeAlternateLike): { out: number; in: number; inPacketSize: number } | undefined {
  const out = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "out");
  const input = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "in");
  return out && input ? { out: out.endpointNumber, in: input.endpointNumber, inPacketSize: input.packetSize } : undefined;
}

/**
 * Finds the CMSIS-DAP v2 interface: vendor class, alternate setting 0, a bulk OUT and a
 * bulk IN endpoint (the first of each; a third, for SWO, is ignored). CMSIS-DAP v2
 * requires the interface string to contain "CMSIS-DAP"; an interface named otherwise is
 * skipped, and one whose name the host cannot read is used only when no named one exists.
 */
export function findDapInterface(device: UsbBulkDeviceLike): DapInterface | undefined {
  let unnamed: DapInterface | undefined;
  for (const usbInterface of device.configuration?.interfaces ?? []) {
    const alternate = usbInterface.alternates.find((candidate) => candidate.alternateSetting === 0);
    if (!alternate || alternate.interfaceClass !== VENDOR_CLASS) continue;
    const pair = bulkPair(alternate);
    if (!pair) continue;
    const found = { interfaceNumber: usbInterface.interfaceNumber, outEndpoint: pair.out, inEndpoint: pair.in, inPacketSize: pair.inPacketSize };
    const name = alternate.interfaceName;
    if (name?.includes("CMSIS-DAP")) return found;
    if (!name) unnamed ??= found;
  }
  return unnamed;
}

export class CmsisDapProbe implements MemoryAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private info_: ProbeInfo = { model: "CMSIS-DAP probe", firmware: "unknown" };
  private closed = false;
  /** DAP packet size, from DAP_Info. Commands never exceed it. */
  private packetSize = MIN_PACKET_SIZE;
  /** Bytes asked for on each IN transfer. */
  private replyLength: number;
  /**
   * Set by the first failed or timed-out transfer. A WebUSB transfer cannot be cancelled,
   * so a late reply would be read as the answer to a later command; after this, every
   * call fails at once and the device is closed.
   */
  private broken: SessionError | undefined;

  private constructor(
    private readonly device: UsbBulkDeviceLike,
    private readonly dap: DapInterface,
    private readonly time: TimeSource,
    private readonly transferTimeoutMs: number,
  ) {
    this.replyLength = Math.max(MIN_PACKET_SIZE, dap.inPacketSize);
  }

  /** Vendor, product and firmware, as read when the probe was opened. */
  get info(): ProbeInfo {
    return this.info_;
  }

  /** True once a transfer failed or timed out; every later call fails at once. */
  get isBroken(): boolean {
    return this.broken !== undefined;
  }

  /**
   * Opens the device, finds and claims its CMSIS-DAP interface, checks that the probe
   * does SWD, starts SWD on it and sets the clock. Does not touch the target yet; call
   * {@link enterSwd} next.
   */
  static async open(device: UsbBulkDeviceLike, options: CmsisDapProbeOptions = {}): Promise<CmsisDapProbe> {
    try {
      if (!device.opened) await device.open();
    } catch (error) {
      throw usbError(
        "Could not open the probe. On Windows, a COM port driver may hold it: in Device Manager, set the probe's driver to USB Composite Device, then plug it in again",
        error,
      );
    }
    if (!device.configuration) {
      try {
        await device.selectConfiguration(CONFIGURATION);
      } catch {
        // Already configured: Windows and some WebUSB backends refuse to set it again.
      }
    }
    const dap = findDapInterface(device);
    if (!dap) {
      await device.close().catch(() => undefined);
      const name = device.productName ? ` (${device.productName})` : "";
      throw new SessionError(
        "probe-firmware",
        `USB device ${usbId(device)}${name} has no CMSIS-DAP v2 interface. On a Flipper Zero, start the DAP Link app before choosing it. A flight controller can share the Flipper's USB IDs.`,
      );
    }
    try {
      await device.claimInterface(dap.interfaceNumber);
    } catch (error) {
      await device.close().catch(() => undefined);
      throw usbError("Could not claim the probe. Close OpenOCD or any other program using it", error);
    }
    const probe = new CmsisDapProbe(device, dap, options.time ?? realTime, options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS);
    try {
      await probe.initialise(options.clockKhz ?? CMSIS_DAP_DEFAULT_CLOCK_KHZ);
    } catch (error) {
      await probe.close();
      throw error;
    }
    return probe;
  }

  private async initialise(clockKhz: number): Promise<void> {
    const packetBytes = await this.readInfo(DapInfo.PACKET_SIZE);
    const packetSize = packetBytes.length >= 2 ? packetBytes[0]! | (packetBytes[1]! << 8) : 0;
    if (packetSize < MIN_PACKET_SIZE) throw new SessionError("probe-firmware", `The probe reports a ${packetSize}-byte packet size; CMSIS-DAP probes use at least ${MIN_PACKET_SIZE}.`);
    this.packetSize = Math.min(packetSize, MAX_PACKET_SIZE);
    this.replyLength = Math.max(this.packetSize, this.dap.inPacketSize);

    const capabilities = (await this.readInfo(DapInfo.CAPABILITIES))[0] ?? 0;
    if ((capabilities & CAPABILITY_SWD) === 0) throw new SessionError("probe-firmware", "The probe does not support SWD.");

    const vendor = infoString(await this.readInfo(DapInfo.VENDOR));
    const product = infoString(await this.readInfo(DapInfo.PRODUCT));
    const protocol = infoString(await this.readInfo(DapInfo.PROTOCOL_VERSION));
    const firmware = infoString(await this.readInfo(DapInfo.PRODUCT_FIRMWARE));
    const model = [vendor, product].filter((part) => part !== "").join(" ") || this.device.productName || "CMSIS-DAP probe";
    this.info_ = { model, firmware: firmware || (protocol ? `CMSIS-DAP ${protocol}` : "unknown") };

    const port = await this.exclusive(async () => (await this.command(connectFrame(PORT_SWD)))[1]);
    if (port !== PORT_SWD) throw new SessionError("probe-firmware", "The probe refused to start SWD.");
    await this.expectOk(swjClockFrame(clockKhz * 1000), `the ${clockKhz} kHz SWD clock`);
    await this.expectOk(transferConfigureFrame(0, WAIT_RETRIES, 0), "the transfer settings");
    await this.expectOk(swdConfigureFrame(0), "the SWD settings");
  }

  /**
   * Line reset and JTAG-to-SWD switch, then reads the debug port's IDCODE, clears its
   * sticky errors, powers up the debug and system domains, and sets the AHB-AP for
   * 32-bit accesses. Throws SessionError "no-target" when the chip does not answer.
   * Resolves with the DP IDCODE.
   */
  async enterSwd(): Promise<number> {
    let last = "";
    for (let attempt = 0; attempt < ENTER_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.time.sleep(ENTER_RETRY_MS);
      await this.expectOk(swjSequenceFrame(SWD_LINE_RESET.bits, SWD_LINE_RESET.data), "the SWD line reset");
      let idcode: number;
      try {
        [idcode] = (await this.transfer([{ ap: false, register: DpRegister.IDCODE }], "the debug port IDCODE")) as [number];
      } catch (error) {
        if (!(error instanceof MemoryAccessError)) throw error;
        last = `${error.message}`;
        continue;
      }
      if (idcode === 0 || idcode === 0xffffffff) {
        last = `the debug port IDCODE read ${hex32(idcode)}`;
        continue;
      }
      try {
        await this.powerUp();
      } catch (error) {
        if (!(error instanceof MemoryAccessError)) throw error;
        last = `powering up the debug port: ${error.message}`;
        continue;
      }
      return idcode;
    }
    throw new SessionError("no-target", `The probe cannot reach the chip (${last}).`);
  }

  /** Re-establishes SWD after the target reset and the debug port dropped. */
  async reattach(): Promise<void> {
    await this.enterSwd();
  }

  async read32(address: number): Promise<number> {
    checkAligned(address);
    const [value] = await this.transfer(
      [
        { ap: true, register: ApRegister.TAR, value: address >>> 0 },
        { ap: true, register: ApRegister.DRW },
      ],
      address,
    );
    return value!;
  }

  async write32(address: number, value: number): Promise<void> {
    checkAligned(address);
    await this.transfer(
      [
        { ap: true, register: ApRegister.TAR, value: address >>> 0 },
        { ap: true, register: ApRegister.DRW, value: value >>> 0 },
      ],
      address,
    );
  }

  async readBlock(address: number, length: number): Promise<Uint8Array> {
    checkAligned(address, length);
    const result = new Uint8Array(length);
    const view = new DataView(result.buffer);
    // Command: 3 + 5 (TAR) + 1 per word. Reply: 3 + 4 per word.
    const perCommand = Math.min(this.packetSize - 8, Math.floor((this.packetSize - 3) / 4), 254);
    for (let offset = 0; offset < length; ) {
      const at = address + offset;
      const words = this.chunkWords(at, (length - offset) / 4, perCommand);
      const transfers: RegisterTransfer[] = [{ ap: true, register: ApRegister.TAR, value: at >>> 0 }];
      for (let index = 0; index < words; index++) transfers.push({ ap: true, register: ApRegister.DRW });
      const values = await this.transfer(transfers, at);
      values.forEach((value, index) => view.setUint32(offset + index * 4, value, true));
      offset += words * 4;
    }
    return result;
  }

  async writeBlock(address: number, data: Uint8Array): Promise<void> {
    checkAligned(address, data.length);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // Command: 3 + 5 (TAR) + 5 per word.
    const perCommand = Math.min(Math.floor((this.packetSize - 8) / 5), 254);
    for (let offset = 0; offset < data.length; ) {
      const at = address + offset;
      const words = this.chunkWords(at, (data.length - offset) / 4, perCommand);
      const transfers: RegisterTransfer[] = [{ ap: true, register: ApRegister.TAR, value: at >>> 0 }];
      for (let index = 0; index < words; index++) transfers.push({ ap: true, register: ApRegister.DRW, value: view.getUint32(offset + index * 4, true) });
      await this.transfer(transfers, at);
      offset += words * 4;
    }
  }

  /** Stops SWD on the probe and releases the device. Never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.broken) await this.exclusive(() => this.command(disconnectFrame())).catch(() => undefined);
    this.closed = true;
    await this.device.releaseInterface(this.dap.interfaceNumber).catch(() => undefined);
    await this.device.close().catch(() => undefined);
  }

  /** Words for the next transfer: what is left, what fits a packet, and what stays inside one 1 KB block. */
  private chunkWords(address: number, remainingWords: number, perCommand: number): number {
    return Math.min(remainingWords, perCommand, (TAR_WINDOW - (address % TAR_WINDOW)) / 4);
  }

  /** Clears sticky errors, requests debug and system power, waits for both, and sets CSW. */
  private async powerUp(): Promise<void> {
    await this.transfer(
      [
        { ap: false, register: DpRegister.ABORT, value: ABORT_CLEAR_STICKY },
        { ap: false, register: DpRegister.SELECT, value: 0 },
        { ap: false, register: DpRegister.CTRL_STAT, value: CTRL_STAT_POWER_UP_REQUEST },
      ],
      "the debug port's power-up request",
    );
    const acked = await pollUntil(
      this.time,
      POWER_UP_TIMEOUT_MS,
      async () => (await this.transfer([{ ap: false, register: DpRegister.CTRL_STAT }], "CTRL/STAT"))[0]!,
      (status) => (status & CTRL_STAT_POWER_UP_ACK) >>> 0 === CTRL_STAT_POWER_UP_ACK,
    );
    if (acked === undefined) throw new MemoryAccessError("no-target", 0, "The debug port did not acknowledge the power-up request.");
    await this.transfer([{ ap: true, register: ApRegister.CSW, value: CSW_WORD_INCREMENT }], "the AHB-AP's CSW");
  }

  /**
   * Runs one DAP_Transfer and resolves with its read values. A FAULT or a WAIT that
   * outlasted the probe's retries is a bus fault: the sticky flags are cleared so the
   * next access can work, and it throws "fault". No answer, or a parity error, means
   * the debug port is gone: "no-target".
   */
  private async transfer(transfers: readonly RegisterTransfer[], where: number | string): Promise<number[]> {
    const sizes = transferSizes(transfers);
    if (sizes.command > this.packetSize || sizes.reply > this.packetSize) throw new RangeError(`A DAP_Transfer of ${transfers.length} transfers does not fit a ${this.packetSize}-byte packet`);
    const reads = transfers.filter((transfer) => transfer.value === undefined).length;
    return this.exclusive(async () => {
      const raw = await this.command(transferFrame(transfers));
      const reply = parseTransferReply(raw);
      if (!reply) throw this.breakDown(usbError("The probe's DAP_Transfer reply is malformed"));
      if (transferSucceeded(reply, transfers.length)) {
        if (reply.data.length < reads * 4) throw this.breakDown(usbError(`The probe returned ${reply.data.length} data bytes where ${reads * 4} were expected`));
        return readValues(reply, reads);
      }
      const ack = reply.response & 0x07;
      // Setting TAR is how every access starts; any other write makes this a write.
      const action = transfers.some((transfer) => transfer.value !== undefined && !(transfer.ap && transfer.register === ApRegister.TAR)) ? "write" : "read";
      const address = typeof where === "number" ? where : 0;
      const message = `SWD ${action} ${typeof where === "number" ? `at ${hex32(where)}` : `of ${where}`} failed: ${responseName(reply.response)}`;
      if (ack === Ack.FAULT || ack === Ack.WAIT) {
        await this.clearSticky(ack === Ack.WAIT);
        throw new MemoryAccessError("fault", address, message);
      }
      throw new MemoryAccessError("no-target", address, message);
    });
  }

  /** Writes ABORT to clear the sticky flags, and DAPABORT after a WAIT. Must run inside {@link exclusive}. */
  private async clearSticky(dapAbort: boolean): Promise<void> {
    const value = ABORT_CLEAR_STICKY | (dapAbort ? ABORT_DAPABORT : 0);
    // Best effort: if this fails too, the next access reports it.
    await this.command(transferFrame([{ ap: false, register: DpRegister.ABORT, value }])).catch((error: unknown) => {
      if (error instanceof SessionError && error.kind === "usb") throw error;
    });
  }

  private async readInfo(id: number): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const data = parseInfoReply(await this.command(infoFrame(id)));
      if (!data) throw this.breakDown(usbError(`The probe's reply to DAP_Info 0x${id.toString(16)} is malformed`));
      return data;
    });
  }

  private async expectOk(frame: Uint8Array, what: string): Promise<void> {
    const status = await this.exclusive(async () => parseStatusReply(await this.command(frame), frame[0]!));
    if (status !== DAP_OK) throw new SessionError("probe-firmware", `The probe refused ${what}.`);
  }

  /** Runs `task` after every earlier command has finished. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Sends one command packet and reads its reply, which must echo the command byte. */
  private async command(frame: Uint8Array): Promise<Uint8Array> {
    if (this.broken) throw new SessionError(this.broken.kind, `The probe is unusable after an earlier failure: ${this.broken.message}`);
    if (this.closed) throw usbError("The probe session is closed");
    if (frame.length > this.packetSize) throw new RangeError(`A ${frame.length}-byte command does not fit a ${this.packetSize}-byte packet`);
    const sent = await this.withTimeout(this.device.transferOut(this.dap.outEndpoint, frame), "send");
    if (sent.status !== undefined && sent.status !== "ok") throw this.breakDown(usbError(`USB send failed (${sent.status})`));
    const received = await this.withTimeout(this.device.transferIn(this.dap.inEndpoint, this.replyLength), "receive");
    if (received.status !== undefined && received.status !== "ok") throw this.breakDown(usbError(`USB receive failed (${received.status})`));
    const view = received.data;
    const reply = view ? new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)) : new Uint8Array(0);
    if (reply[0] !== frame[0]) {
      const got = reply.length === 0 ? "nothing" : `0x${reply[0]!.toString(16).padStart(2, "0")}`;
      throw this.breakDown(usbError(`The probe answered command 0x${frame[0]!.toString(16).padStart(2, "0")} with ${got}`));
    }
    return reply;
  }

  /**
   * Any failed, short or late transfer leaves the command stream out of step with the
   * probe's replies. Marks the probe unusable and closes the device, which also ends a
   * transfer still pending. Returns the error to throw.
   */
  private breakDown(error: SessionError): SessionError {
    if (!this.broken) {
      this.broken = error;
      void this.device.close().catch(() => undefined);
    }
    return error;
  }

  private async withTimeout<T>(transfer: Promise<T>, action: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SessionError("timeout", `The probe did not ${action} within ${this.transferTimeoutMs / 1000} s.`)), this.transferTimeoutMs);
    });
    try {
      return await Promise.race([transfer, timeout]);
    } catch (error) {
      if (error instanceof SessionError) throw this.breakDown(error);
      throw this.breakDown(usbError(`USB ${action} failed`, error));
    } finally {
      clearTimeout(timer);
    }
  }
}
