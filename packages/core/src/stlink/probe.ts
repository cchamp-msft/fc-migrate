/**
 * One open ST-Link V2 or V2-1: USB framing, the probe's own mode handling, entering SWD,
 * and 32-bit memory access to the target. Commands are serialised, so a memory command
 * and its status read can never interleave with another caller's.
 */
import { MemoryAccessError, hex32, type MemoryAccess } from "../swd/memory-access.js";
import { realTime, type TimeSource } from "../swd/time.js";
import { SessionError, type ProbeInfo, type UsbBulkDeviceLike } from "../targets/stm32g4/session.js";
import {
  ProbeMode,
  ReplyLength,
  StlinkStatus,
  currentModeFrame,
  dfuExitFrame,
  enterSwdFrame,
  exitDebugFrame,
  formatFirmware,
  isDebugPortStatus,
  isWaitStatus,
  lastRwStatusFrame,
  parseCurrentMode,
  parseDebugRegRead,
  parseIdcodes,
  parseRwStatus,
  parseTargetVoltage,
  parseVersion,
  readDebugRegFrame,
  readIdcodesFrame,
  readMem32Frame,
  statusName,
  swdClockFor,
  swdClockFrame,
  swimExitFrame,
  targetVoltageFrame,
  versionFrame,
  writeDebugRegFrame,
  writeMem32Frame,
  type StlinkVersion,
} from "./frames.js";
import { DEFAULT_SWD_CLOCK_KHZ, MIN_JTAG_FIRMWARE, stlinkModelFor, type StlinkModel } from "./models.js";

/** Real-time limit for one USB transfer. The probe answers in milliseconds when healthy. */
const DEFAULT_TRANSFER_TIMEOUT_MS = 3000;
/** How often a WAIT answer is retried before it counts as a failure. */
const WAIT_RETRIES = 8;
/** Memory transfers never cross this boundary: the AP's address auto-increment wraps there. */
const TAR_WINDOW = 1024;
const CONFIGURATION = 1;
/** ENTER is retried this often, briefly, because the first try after a target reset can fail. */
const ENTER_ATTEMPTS = 3;
const ENTER_RETRY_MS = 100;

export interface StlinkProbeOptions {
  /** SWD clock; rounded down to the nearest rate the probe supports. Default {@link DEFAULT_SWD_CLOCK_KHZ}. */
  clockKhz?: number;
  time?: TimeSource;
  /** Real-time limit for one USB transfer. Default 3 s. A timeout makes the probe unusable. */
  transferTimeoutMs?: number;
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

export class StlinkProbe implements MemoryAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private info_: ProbeInfo;
  private closed = false;
  /**
   * Set by the first failed or timed-out transfer. A WebUSB transfer cannot be cancelled,
   * so a late reply would be read as the answer to a later command; after this, every
   * call fails at once and the device is closed.
   */
  private broken: SessionError | undefined;

  private constructor(
    private readonly device: UsbBulkDeviceLike,
    readonly model: StlinkModel,
    private readonly time: TimeSource,
    private readonly transferTimeoutMs: number,
  ) {
    this.info_ = { model: model.name, firmware: "unknown" };
  }

  /** Model, firmware and target voltage, as read when the probe was opened. */
  get info(): ProbeInfo {
    return this.info_;
  }

  /**
   * Opens and claims the probe, checks its firmware, takes it out of DFU or a leftover
   * debug session, reads the target voltage and sets the SWD clock. Does not touch the
   * target yet; call {@link enterSwd} next.
   */
  static async open(device: UsbBulkDeviceLike, options: StlinkProbeOptions = {}): Promise<StlinkProbe> {
    const model = stlinkModelFor(device.vendorId, device.productId);
    if (!model) {
      const id = `${device.vendorId.toString(16).padStart(4, "0")}:${device.productId.toString(16).padStart(4, "0")}`;
      throw new SessionError("probe-firmware", `USB device ${id} is not an ST-Link/V2 or V2-1.`);
    }
    try {
      if (!device.opened) await device.open();
    } catch (error) {
      throw usbError("Could not open the ST-Link", error);
    }
    try {
      await device.selectConfiguration(CONFIGURATION);
    } catch {
      // Already configured: Windows and some WebUSB backends refuse to set it again.
    }
    try {
      await device.claimInterface(model.interfaceNumber);
    } catch (error) {
      await device.close().catch(() => undefined);
      throw usbError("Could not claim the ST-Link. Close STM32CubeProgrammer or any other program using it", error);
    }

    const probe = new StlinkProbe(device, model, options.time ?? realTime, options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS);
    try {
      await probe.initialise(options.clockKhz ?? DEFAULT_SWD_CLOCK_KHZ);
    } catch (error) {
      await probe.close();
      throw error;
    }
    return probe;
  }

  private async initialise(clockKhz: number): Promise<void> {
    const version = await this.exclusive(async () => parseVersion(await this.transact(versionFrame(), ReplyLength.VERSION)));
    this.checkFirmware(version);

    const mode = await this.exclusive(async () => parseCurrentMode(await this.transact(currentModeFrame(), ReplyLength.CURRENT_MODE)));
    if (mode === ProbeMode.DFU) await this.exclusive(() => this.transact(dfuExitFrame(), 0));
    else if (mode === ProbeMode.DEBUG) await this.exclusive(() => this.transact(exitDebugFrame(), 0));
    else if (mode === ProbeMode.SWIM) await this.exclusive(() => this.transact(swimExitFrame(), 0));

    let targetVolts: number | undefined;
    try {
      targetVolts = await this.exclusive(async () => parseTargetVoltage(await this.transact(targetVoltageFrame(), ReplyLength.TARGET_VOLTAGE)));
    } catch (error) {
      // Informational only, but a lost probe is still a lost probe.
      if (error instanceof SessionError && error.kind === "usb") throw error;
    }
    this.info_ = { model: this.model.name, firmware: formatFirmware(version), ...(targetVolts === undefined ? {} : { targetVolts }) };

    const clock = swdClockFor(clockKhz);
    const status = await this.exclusive(async () => (await this.transact(swdClockFrame(clock.divisor), ReplyLength.STATUS))[0]!);
    if (status !== StlinkStatus.OK) {
      throw new SessionError("probe-firmware", `The ST-Link refused the ${clock.khz} kHz SWD clock (${statusName(status)}).`);
    }
  }

  private checkFirmware(version: StlinkVersion): void {
    const firmware = formatFirmware(version);
    if (version.stlink !== 2) throw new SessionError("probe-firmware", `ST-Link hardware version ${version.stlink} (${firmware}) is not supported; use a V2 or V2-1.`);
    if (version.jtag < MIN_JTAG_FIRMWARE) {
      throw new SessionError(
        "probe-firmware",
        `ST-Link firmware ${firmware} is too old; J${MIN_JTAG_FIRMWARE} or newer is needed. Update it with ST's ST-LINK firmware upgrade tool.`,
      );
    }
  }

  /**
   * Enters SWD mode and reads the debug port's IDCODE, which proves the target answers.
   * Throws SessionError "no-target" when it does not. Resolves with the DP IDCODE.
   */
  async enterSwd(): Promise<number> {
    let last = "";
    for (let attempt = 0; attempt < ENTER_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.time.sleep(ENTER_RETRY_MS);
      const status = await this.exclusive(async () => (await this.transact(enterSwdFrame(), ReplyLength.STATUS))[0]!);
      if (status !== StlinkStatus.OK) {
        last = `entering SWD answered ${statusName(status)}`;
        continue;
      }
      const { status: idStatus, idcode } = await this.exclusive(async () => parseIdcodes(await this.transact(readIdcodesFrame(), ReplyLength.IDCODES)));
      if (idStatus === StlinkStatus.OK && idcode !== 0 && idcode !== 0xffffffff) return idcode;
      last = idStatus === StlinkStatus.OK ? `the debug port IDCODE read ${hex32(idcode)}` : `reading the debug port IDCODE answered ${statusName(idStatus)}`;
    }
    throw new SessionError("no-target", `The ST-Link cannot reach the chip (${last}).`);
  }

  /** Leaves debug mode; the probe releases the SWD lines. */
  async exitDebug(): Promise<void> {
    await this.exclusive(() => this.transact(exitDebugFrame(), 0));
  }

  /** Re-establishes SWD after the target reset and the debug port dropped. */
  async reattach(): Promise<void> {
    try {
      await this.exitDebug();
    } catch (error) {
      if (error instanceof SessionError && error.kind === "usb") throw error;
    }
    await this.enterSwd();
  }

  async read32(address: number): Promise<number> {
    checkAligned(address);
    return this.exclusive(async () => {
      for (let attempt = 0; ; attempt++) {
        const { status, value } = parseDebugRegRead(await this.transact(readDebugRegFrame(address), ReplyLength.READ_DEBUG_REG));
        if (status === StlinkStatus.OK) return value;
        if (isWaitStatus(status) && attempt < WAIT_RETRIES) {
          await this.time.sleep(1);
          continue;
        }
        throw this.accessError(status, address, "read");
      }
    });
  }

  async write32(address: number, value: number): Promise<void> {
    checkAligned(address);
    await this.exclusive(async () => {
      for (let attempt = 0; ; attempt++) {
        const status = (await this.transact(writeDebugRegFrame(address, value >>> 0), ReplyLength.STATUS))[0]!;
        if (status === StlinkStatus.OK) return;
        if (isWaitStatus(status) && attempt < WAIT_RETRIES) {
          await this.time.sleep(1);
          continue;
        }
        throw this.accessError(status, address, "write");
      }
    });
  }

  async readBlock(address: number, length: number): Promise<Uint8Array> {
    checkAligned(address, length);
    const result = new Uint8Array(length);
    for (let offset = 0; offset < length; ) {
      const at = address + offset;
      const size = this.chunkSize(at, length - offset);
      const bytes = await this.exclusive(async () => {
        for (let attempt = 0; ; attempt++) {
          const data = await this.transact(readMem32Frame(at, size), size);
          const { status, faultAddress } = await this.rwStatus();
          if (status === StlinkStatus.OK) return data;
          if (isWaitStatus(status) && attempt < WAIT_RETRIES) {
            await this.time.sleep(1);
            continue;
          }
          throw this.accessError(status, faultAddress || at, "read");
        }
      });
      result.set(bytes, offset);
      offset += size;
    }
    return result;
  }

  async writeBlock(address: number, data: Uint8Array): Promise<void> {
    checkAligned(address, data.length);
    for (let offset = 0; offset < data.length; ) {
      const at = address + offset;
      const size = this.chunkSize(at, data.length - offset);
      const chunk = data.subarray(offset, offset + size);
      await this.exclusive(async () => {
        for (let attempt = 0; ; attempt++) {
          await this.transact(writeMem32Frame(at, size), 0, chunk);
          const { status, faultAddress } = await this.rwStatus();
          if (status === StlinkStatus.OK) return;
          if (isWaitStatus(status) && attempt < WAIT_RETRIES) {
            await this.time.sleep(1);
            continue;
          }
          throw this.accessError(status, faultAddress || at, "write");
        }
      });
      offset += size;
    }
  }

  /** True once a transfer failed or timed out; every later call fails at once. */
  get isBroken(): boolean {
    return this.broken !== undefined;
  }

  /** Leaves debug mode and releases the device. Never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.broken) await this.exclusive(() => this.transact(exitDebugFrame(), 0)).catch(() => undefined);
    this.closed = true;
    await this.device.releaseInterface(this.model.interfaceNumber).catch(() => undefined);
    await this.device.close().catch(() => undefined);
  }

  private chunkSize(address: number, remaining: number): number {
    return Math.min(remaining, this.model.maxTransfer, TAR_WINDOW - (address % TAR_WINDOW));
  }

  private async rwStatus(): Promise<{ status: number; faultAddress: number }> {
    return parseRwStatus(await this.transact(lastRwStatusFrame(), ReplyLength.RW_STATUS2));
  }

  private accessError(status: number, address: number, action: "read" | "write"): MemoryAccessError {
    const failure = isDebugPortStatus(status) ? "no-target" : "fault";
    return new MemoryAccessError(failure, address, `SWD ${action} at ${hex32(address)} failed: ${statusName(status)}`);
  }

  /** Runs `task` after every earlier command has finished. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** One command block, an optional OUT data phase, then a reply of `replyLength` bytes (none when 0). */
  private async transact(command: Uint8Array, replyLength: number, data?: Uint8Array): Promise<Uint8Array> {
    if (this.broken) throw new SessionError(this.broken.kind, `The ST-Link is unusable after an earlier failure: ${this.broken.message}`);
    if (this.closed) throw usbError("The ST-Link session is closed");
    await this.transferOut(command);
    if (data) await this.transferOut(data);
    return replyLength > 0 ? this.transferIn(replyLength) : new Uint8Array(0);
  }

  private async transferOut(data: Uint8Array): Promise<void> {
    const result = await this.withTimeout(this.device.transferOut(this.model.outEndpoint, data), "send");
    if (result.status !== undefined && result.status !== "ok") throw this.breakDown(usbError(`USB send failed (${result.status})`));
  }

  private async transferIn(length: number): Promise<Uint8Array> {
    const result = await this.withTimeout(this.device.transferIn(this.model.inEndpoint, length), "receive");
    if (result.status !== undefined && result.status !== "ok") throw this.breakDown(usbError(`USB receive failed (${result.status})`));
    const view = result.data;
    if (!view || view.byteLength < length) throw this.breakDown(usbError(`The ST-Link sent ${view?.byteLength ?? 0} bytes where ${length} were expected`));
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + length));
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
      timer = setTimeout(
        () => reject(new SessionError("timeout", `The ST-Link did not ${action} within ${this.transferTimeoutMs / 1000} s.`)),
        this.transferTimeoutMs,
      );
    });
    try {
      return await Promise.race([transfer, timeout]);
    } catch (error) {
      throw this.breakDown(error instanceof SessionError ? error : usbError(`USB ${action} failed`, error));
    } finally {
      clearTimeout(timer);
    }
  }
}
