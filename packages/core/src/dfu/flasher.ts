/*
 * This file is part of Betaflight.
 *
 * Betaflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Betaflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

import { DEMO_IMAGE_REFUSED, isDemoImage } from "../firmware/demo-image.js";
import type { HexImage } from "../firmware/hex.js";
import type { UsbControlSetup, UsbDeviceLike, UsbTransferStatus } from "./usb-device.js";

const REQUEST_DNLOAD = 0x01;
const REQUEST_UPLOAD = 0x02;
const REQUEST_GETSTATUS = 0x03;
const REQUEST_CLRSTATUS = 0x04;
const REQUEST_ABORT = 0x06;

const COMMAND_SET_ADDRESS = 0x21;
const COMMAND_ERASE = 0x41;

const STATE_IDLE = 2;
const STATE_DNBUSY = 4;
const STATE_DNLOAD_IDLE = 5;
const STATE_UPLOAD_IDLE = 9;
const STATE_ERROR = 10;
const STATUS_ERR_VENDOR = 0x0b;

const USB_GET_DESCRIPTOR = 6;
const DESCRIPTOR_CONFIGURATION = 0x0200;
const DESCRIPTOR_STRING = 0x0300;
const DESCRIPTOR_DFU_FUNCTIONAL = 0x2100;
const TYPE_INTERFACE = 4;
const TYPE_DFU_FUNCTIONAL = 0x21;
const CLASS_APPLICATION_SPECIFIC = 0xfe;
const SUBCLASS_DFU = 0x01;
const DEFAULT_LANGUAGE_ID = 0x0409;

const DFU_INTERFACE = 0;
const FIRST_DATA_BLOCK = 2;
const DEFAULT_TRANSFER_SIZE = 2048;
const DEFAULT_LEAVE_ADDRESS = 0x08000000;
const TRANSFER_TIMEOUT_MS = 5000;
const CLEAR_STATUS_ATTEMPTS = 100;
const SETTLE_ATTEMPTS = 8;
const CLAIM_ATTEMPTS = 6;
const CLAIM_RETRY_MS = 1000;

// The Configurator's parser cut every image at 64 KiB boundaries and loaded a new
// address for each piece, so that is the wBlockNum range proven on real bootloaders.
// HexImage merges contiguous records, so the flasher restores that cadence itself.
const ADDRESS_WINDOW = 0x10000;

const STATUS_NAMES = [
  "OK",
  "errTARGET",
  "errFILE",
  "errWRITE",
  "errERASE",
  "errCHECK_ERASED",
  "errPROG",
  "errVERIFY",
  "errADDRESS",
  "errNOTDONE",
  "errFIRMWARE",
  "errVENDOR",
  "errUSBR",
  "errPOR",
  "errUNKNOWN",
  "errSTALLEDPKT",
];

const STATE_NAMES = [
  "appIDLE",
  "appDETACH",
  "dfuIDLE",
  "dfuDNLOAD-SYNC",
  "dfuDNBUSY",
  "dfuDNLOAD-IDLE",
  "dfuMANIFEST-SYNC",
  "dfuMANIFEST",
  "dfuMANIFEST-WAIT-RESET",
  "dfuUPLOAD-IDLE",
  "dfuERROR",
];

/** A DFU_GETSTATUS reply. */
export interface DfuDeviceStatus {
  status: number;
  statusName: string;
  state: number;
  stateName: string;
  /** bwPollTimeout: milliseconds to wait before the next GETSTATUS. */
  pollTimeout: number;
}

export type DfuStage = "open" | "erase" | "write" | "verify" | "read" | "leave";

export interface DfuProgress {
  stage: "erase" | "write" | "verify" | "read";
  done: number;
  total: number;
}

export type DfuProgressCallback = (progress: DfuProgress) => void;

export interface DfuFlashOptions {
  /** Erase every page of the flash rather than only the pages the firmware touches. */
  fullChipErase?: boolean;
}

/** One run of equally sized pages in a memory region. */
export interface DfuSector {
  startAddress: number;
  pageCount: number;
  pageSize: number;
  totalSize: number;
}

/** A memory region parsed from a DFU alternate-setting string. */
export interface DfuMemoryRegion {
  name: string;
  alternateSetting: number;
  startAddress: number;
  totalSize: number;
  sectors: DfuSector[];
}

export interface DfuMemoryLayout {
  /** Keyed by lower-cased name: "internal_flash", "option_bytes" and so on. */
  regions: Record<string, DfuMemoryRegion>;
  /** The region flash() and readFlash() work on: internal flash, else external. */
  flash: DfuMemoryRegion;
  transferSize: number;
}

export class DfuError extends Error {
  constructor(
    readonly stage: DfuStage,
    message: string,
    readonly status?: DfuDeviceStatus,
    options?: ErrorOptions,
  ) {
    const suffix = status ? ` (status ${status.statusName}, state ${status.stateName})` : "";
    super(`DFU ${stage} failed: ${message}${suffix}`, options);
    this.name = "DfuError";
  }
}

/** The bootloader refused access in the way read protection (RDP) does. */
export class DfuReadProtectedError extends DfuError {
  constructor(stage: DfuStage, status?: DfuDeviceStatus, options?: ErrorOptions) {
    super(stage, "the board appears to be read protected", status, options);
    this.name = "DfuReadProtectedError";
  }
}

/** A firmware image or read request does not fit the flash. Raised before any device traffic. */
export class DfuAddressError extends DfuError {
  constructor(stage: DfuStage, message: string) {
    super(stage, message);
    this.name = "DfuAddressError";
  }
}

/** The image must never be written, whatever the device: raised before any device traffic. */
export class DfuRefusedError extends DfuError {
  constructor(stage: DfuStage, message: string) {
    super(stage, message);
    this.name = "DfuRefusedError";
  }
}

/** Read-back differed from the firmware. The device reported no error of its own. */
export class DfuVerifyError extends DfuError {
  constructor(
    readonly address: number,
    readonly expected: number,
    readonly actual: number,
    status?: DfuDeviceStatus,
  ) {
    super("verify", `flash at ${hexAddress(address)} holds ${hexByte(actual)}, expected ${hexByte(expected)}`, status);
    this.name = "DfuVerifyError";
  }
}

interface RawInResult {
  status: UsbTransferStatus | undefined;
  data: Uint8Array;
}

type RawIn = (setup: UsbControlSetup, length: number, label: string) => Promise<RawInResult>;

interface AddressWindow {
  address: number;
  offset: number;
  length: number;
}

function hexAddress(address: number): string {
  return `0x${address.toString(16).padStart(8, "0")}`;
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string | undefined {
  return (error as { name?: string } | null | undefined)?.name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fails a USB operation that never settles, so a wedged bootloader cannot hang a flash forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseStatus(data: Uint8Array): DfuDeviceStatus {
  const status = data[0]!;
  const state = data[4]!;
  return {
    status,
    statusName: STATUS_NAMES[status] ?? `unknown status ${status}`,
    state,
    stateName: STATE_NAMES[state] ?? `unknown state ${state}`,
    pollTimeout: data[1]! | (data[2]! << 8) | (data[3]! << 16),
  };
}

function addressCommand(command: number, address: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(command, address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff, (address >> 24) & 0xff);
}

/** Splits a range so each piece starts a new address pointer. See ADDRESS_WINDOW. */
function* addressWindows(address: number, length: number): Generator<AddressWindow> {
  let offset = 0;
  while (offset < length) {
    const start = address + offset;
    const size = Math.min(ADDRESS_WINDOW - (start % ADDRESS_WINDOW), length - offset);
    yield { address: start, offset, length: size };
    offset += size;
  }
}

function fixKnownLayoutString(text: string): string {
  // Early H750 SPRacing bootloaders report an incorrect partition table.
  if (text === "@External Flash /0x90000000/1001*128Kg,3*128Kg,20*128Ka") {
    return "@External Flash /0x90000000/998*128Kg,1*128Kg,4*128Kg,21*128Ka";
  }
  if (text === "@Option byte   /0x1FFFC000/01*4096 g") return "@Option bytes   /0x1FFFC000/01*4096 g";
  if (text === "@Option byte   /0x1FFFC000/01*512 g") return "@Option bytes   /0x1FFFC000/01*512 g";
  return text.startsWith("@InternalFlash") ? text.replace("@InternalFlash", "@Internal Flash") : text;
}

function pageSizeBytes(field: string): number {
  const size = Number.parseInt(field);
  const unit = field.slice(-2, -1);
  if (unit === "K") return size * 1024;
  if (unit === "M") return size * 1024 * 1024;
  return size;
}

/**
 * Parses a DfuSe alternate-setting string such as
 * "@Internal Flash  /0x08000000/04*016Kg,01*64Kg,03*128Kg". Returns undefined for a
 * string it cannot read, because one unrecognised region must not stop a board that
 * still reports a usable flash.
 */
export function parseDfuMemoryString(text: string, alternateSetting = 0): DfuMemoryRegion | undefined {
  // A G474 reports two banks of option bytes as ".../0x1FFF7800/01*048 e/0x1FFFF800/01*048 e":
  // anything after the first sector list is deliberately dropped.
  const [label, start, sectorList] = fixKnownLayoutString(text)
    .replaceAll(/[^\x20-\x7E]+/g, "")
    .split("/");
  if (!label?.startsWith("@") || start === undefined || sectorList === undefined) return undefined;

  const startAddress = Number.parseInt(start);
  if (!Number.isFinite(startAddress)) return undefined;

  const sectors: DfuSector[] = [];
  let totalSize = 0;
  for (const entry of sectorList.split(",")) {
    const parts = entry.split("*");
    if (parts.length !== 2) return undefined;
    const pageCount = Number.parseInt(parts[0]!);
    const pageSize = pageSizeBytes(parts[1]!);
    if (!Number.isFinite(pageCount) || !pageSize) return undefined;
    sectors.push({ startAddress: startAddress + totalSize, pageCount, pageSize, totalSize: pageCount * pageSize });
    totalSize += pageCount * pageSize;
  }

  return { name: label.trim().replace("@", ""), alternateSetting, startAddress, totalSize, sectors };
}

function regionKey(name: string): string {
  return name.toLowerCase().replace(" ", "_");
}

function regionContains(region: DfuMemoryRegion, address: number, length: number): boolean {
  return address >= region.startAddress && address + length <= region.startAddress + region.totalSize;
}

function assertFirmwareFits(firmware: HexImage, flash: DfuMemoryRegion): void {
  if (!firmware.data.some((block) => block.bytes.length > 0)) {
    throw new DfuAddressError("erase", "the firmware image is empty");
  }
  for (const block of firmware.data) {
    if (!regionContains(flash, block.address, block.bytes.length)) {
      const end = block.address + block.bytes.length;
      throw new DfuAddressError("erase", `firmware range ${hexAddress(block.address)}-${hexAddress(end)} is outside the ${flash.name}`);
    }
  }
}

function pagesToErase(flash: DfuMemoryRegion, firmware: HexImage, fullChip: boolean): number[] {
  const pages: number[] = [];
  for (const sector of flash.sectors) {
    for (let page = 0; page < sector.pageCount; page++) {
      const pageStart = sector.startAddress + page * sector.pageSize;
      const pageEnd = pageStart + sector.pageSize - 1;
      const touched = firmware.data.some(
        (block) => block.bytes.length > 0 && block.address <= pageEnd && block.address + block.bytes.length - 1 >= pageStart,
      );
      if (fullChip || touched) pages.push(pageStart);
    }
  }
  return pages;
}

function functionalTransferSize(buf: Uint8Array, offset: number): number | undefined {
  // A device may declare a longer descriptor, so require at least 9 bytes rather than exactly 9.
  if (buf[offset + 1] !== TYPE_DFU_FUNCTIONAL || buf[offset]! < 9 || offset + 9 > buf.length) return undefined;
  return (buf[offset + 5]! | (buf[offset + 6]! << 8)) || undefined;
}

function getDescriptor(value: number, index = 0, recipient: UsbControlSetup["recipient"] = "device"): UsbControlSetup {
  return { requestType: "standard", recipient, request: USB_GET_DESCRIPTOR, value, index };
}

/** Reads the USB descriptors the flasher needs, on top of raw control transfers. */
class DfuDescriptorReader {
  private languageId: number | undefined;
  private config: Uint8Array | undefined;

  constructor(private readonly rawIn: RawIn) {}

  /** The strings of the alternate settings of one interface, in descriptor order. */
  async alternateStrings(interfaceNumber: number): Promise<{ alternateSetting: number; text: string }[]> {
    const buf = await this.configDescriptor();
    const strings: { alternateSetting: number; text: string }[] = [];
    for (let offset = 9; offset + 1 < buf.length; offset += buf[offset]! || 1) {
      if (buf[offset + 1] !== TYPE_INTERFACE || offset + 9 > buf.length) continue;
      if (buf[offset + 2] !== interfaceNumber) continue;
      try {
        strings.push({ alternateSetting: buf[offset + 3]!, text: await this.string(buf[offset + 8]!) });
      } catch {
        break;
      }
    }
    return strings;
  }

  /**
   * The DFU wTransferSize. Read from the configuration descriptor first because some
   * ST ROMs (STM32C5) never answer a standalone request for the functional descriptor.
   */
  async transferSize(): Promise<number> {
    try {
      const size = this.transferSizeFromConfig(await this.configDescriptor());
      if (size !== undefined) return size;
    } catch {
      // The standalone request below is the fallback.
    }
    try {
      const result = await this.rawIn(getDescriptor(DESCRIPTOR_DFU_FUNCTIONAL, 0, "interface"), 255, "functional descriptor");
      const size = result.status === "ok" ? functionalTransferSize(result.data, 0) : undefined;
      if (size !== undefined) return size;
    } catch {
      // A zero or missing size must never reach the write loop.
    }
    return DEFAULT_TRANSFER_SIZE;
  }

  private transferSizeFromConfig(buf: Uint8Array): number | undefined {
    // 0x21 is also the HID descriptor type, so only accept one inside a DFU interface.
    let inDfuInterface = false;
    for (let offset = 0; offset + 1 < buf.length; offset += buf[offset]! || 1) {
      const type = buf[offset + 1];
      if (type === TYPE_INTERFACE && offset + 9 <= buf.length) {
        inDfuInterface = buf[offset + 5] === CLASS_APPLICATION_SPECIFIC && buf[offset + 6] === SUBCLASS_DFU;
      } else if (inDfuInterface && type === TYPE_DFU_FUNCTIONAL) {
        const size = functionalTransferSize(buf, offset);
        if (size !== undefined) return size;
      }
    }
    return undefined;
  }

  private async configDescriptor(): Promise<Uint8Array> {
    if (this.config) return this.config;
    const setup = getDescriptor(DESCRIPTOR_CONFIGURATION);
    const header = await this.rawIn(setup, 9, "configuration descriptor header");
    if (header.status !== "ok" || header.data.length < 4) {
      throw new Error(`Configuration descriptor header read failed: ${header.status}, ${header.data.length} bytes`);
    }
    // wTotalLength is device-supplied; real descriptors are at most a couple of KiB.
    const totalLength = header.data[2]! | (header.data[3]! << 8);
    if (totalLength < 9 || totalLength > 4096) {
      throw new Error(`Configuration descriptor reported an implausible length of ${totalLength}`);
    }
    const full = await this.rawIn(setup, totalLength, "configuration descriptor");
    if (full.status !== "ok" || full.data.length < totalLength) {
      throw new Error(`Configuration descriptor read failed: ${full.status}, ${full.data.length} of ${totalLength} bytes`);
    }
    this.config = full.data;
    return full.data;
  }

  private async language(): Promise<number> {
    if (this.languageId !== undefined) return this.languageId;
    let languageId = DEFAULT_LANGUAGE_ID;
    try {
      const result = await this.rawIn(getDescriptor(DESCRIPTOR_STRING), 255, "language ID");
      if (result.status === "ok" && result.data.length >= 4) languageId = result.data[2]! | (result.data[3]! << 8);
    } catch {
      // Fall back to English (US).
    }
    this.languageId = languageId;
    return languageId;
  }

  private async string(index: number): Promise<string> {
    if (index === 0) return "";
    const result = await this.rawIn(getDescriptor(DESCRIPTOR_STRING | index, await this.language()), 255, `string ${index}`);
    if (result.status !== "ok") throw new Error(`String ${index} read failed: ${result.status}`);
    const length = Math.min(result.data[0] ?? 0, result.data.length);
    let text = "";
    for (let i = 2; i + 1 < length; i += 2) text += String.fromCodePoint(result.data[i]! | (result.data[i + 1]! << 8));
    return text;
  }
}

function describeOpenFailure(error: unknown): string {
  if (errorName(error) === "SecurityError") {
    return "the operating system denied access to the device (a missing udev rule on Linux, or no WinUSB driver bound on Windows)";
  }
  return `could not open the device: ${describeError(error)}`;
}

function isInterfaceBusy(error: unknown): boolean {
  const message = describeError(error);
  return message.includes("Unable to claim interface") || message.includes("busy");
}

/**
 * STM32 USB DFU (DfuSe) flasher, ported from the Betaflight Configurator.
 *
 * DFU refuses most requests unless the device is in the right state, so each operation
 * returns the device to dfuIDLE with clearStatus() before starting another.
 */
export class DfuFlasher {
  private layout: DfuMemoryLayout | undefined;
  private connected = false;
  private busy = false;
  private stage: DfuStage = "open";
  private lastStatus: DfuDeviceStatus | undefined;

  constructor(
    private readonly device: UsbDeviceLike,
    private readonly onProgress?: DfuProgressCallback,
  ) {}

  /** Opens and claims the device and reads its memory layout. */
  open(): Promise<DfuMemoryLayout> {
    return this.exclusive("open", async () => {
      await this.connect();
      try {
        await this.settleInterruptedRun();
        const layout = await this.readLayout();
        await this.selectAlternate(layout.flash.alternateSetting);
        this.layout = layout;
        return layout;
      } catch (error) {
        await this.disconnect();
        throw error instanceof DfuError ? error : new DfuError("open", describeError(error), undefined, { cause: error });
      }
    });
  }

  /**
   * Reads flash back through DFU_UPLOAD. A read-protected board raises
   * DfuReadProtectedError. The device stays open on failure, so the caller can still
   * flash or leave.
   */
  readFlash(startAddress: number, length: number): Promise<Uint8Array> {
    return this.exclusive("read", async () => {
      const { flash } = this.requireLayout();
      if (!Number.isInteger(startAddress) || !Number.isInteger(length) || length < 0 || !regionContains(flash, startAddress, length)) {
        throw new DfuAddressError("read", `range ${hexAddress(startAddress)}+${length} is outside the ${flash.name}`);
      }
      this.report("read", 0, length);
      return this.uploadRange(startAddress, length, (done) => this.report("read", done, length));
    });
  }

  /**
   * Erases, writes, verifies and then leaves DFU so the new firmware boots. A firmware
   * image that does not fit is refused before any device traffic and the device stays
   * open. Any later failure releases and closes the device without leaving DFU, so
   * the board stays in the bootloader and can be flashed again.
   */
  flash(firmware: HexImage, options: DfuFlashOptions = {}): Promise<void> {
    return this.exclusive("erase", async () => {
      const { regions, flash } = this.requireLayout();
      // The last gate before a real board's flash: no caller can hand the demo's stand-in through.
      if (isDemoImage(firmware.data)) throw new DfuRefusedError("erase", DEMO_IMAGE_REFUSED);
      assertFirmwareFits(firmware, flash);
      try {
        await this.clearStatus();
        // External flash has no option bytes to check.
        if (flash === regions.internal_flash && regions.option_bytes) await this.checkReadProtection(regions.option_bytes);
        await this.erase(pagesToErase(flash, firmware, options.fullChipErase === true));
        this.stage = "write";
        await this.write(firmware);
        this.stage = "verify";
        await this.verify(firmware);
      } catch (error) {
        await this.disconnect();
        throw error;
      }
      await this.leaveDfu(firmware.data[0]!.address);
    });
  }

  /** Leaves DFU without flashing, claiming the device first if needed. */
  leave(): Promise<void> {
    return this.exclusive("leave", async () => {
      await this.connect();
      await this.leaveDfu(DEFAULT_LEAVE_ADDRESS);
    });
  }

  /** Releases and closes the device. */
  close(): Promise<void> {
    return this.exclusive(this.stage, () => this.disconnect());
  }

  private async exclusive<T>(stage: DfuStage, run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new DfuError(stage, "another DFU operation is already in progress");
    this.busy = true;
    this.stage = stage;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }

  private requireLayout(): DfuMemoryLayout {
    if (!this.layout) throw new DfuError(this.stage, "the device is not open; call open() first");
    return this.layout;
  }

  private report(stage: DfuProgress["stage"], done: number, total: number): void {
    try {
      this.onProgress?.({ stage, done, total });
    } catch {
      // A bug in a progress handler must not abort a flash halfway through.
    }
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.device.open();
      if (!this.device.configuration) await this.device.selectConfiguration(1);
      await this.claimInterface();
      this.connected = true;
    } catch (error) {
      await this.disconnect();
      throw new DfuError("open", describeOpenFailure(error), undefined, { cause: error });
    }
  }

  private async claimInterface(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.device.claimInterface(DFU_INTERFACE);
        return;
      } catch (error) {
        if (!isInterfaceBusy(error) || attempt >= CLAIM_ATTEMPTS) throw error;
        await sleep(CLAIM_RETRY_MS);
      }
    }
  }

  private async disconnect(): Promise<void> {
    this.connected = false;
    this.layout = undefined;
    // releaseInterface fails on some devices, and after leaving DFU the device is gone.
    // Neither matters, and close must still be attempted.
    try {
      await this.device.releaseInterface(DFU_INTERFACE);
    } catch {
      // See above.
    }
    try {
      await this.device.close();
    } catch {
      // See above.
    }
  }

  private async readLayout(): Promise<DfuMemoryLayout> {
    const reader = new DfuDescriptorReader((setup, length, label) => this.rawIn(setup, length, label));
    const regions: Record<string, DfuMemoryRegion> = {};
    for (const { alternateSetting, text } of await reader.alternateStrings(DFU_INTERFACE)) {
      const region = parseDfuMemoryString(text, alternateSetting);
      if (region) regions[regionKey(region.name)] = region;
    }
    const flash = regions.internal_flash ?? regions.external_flash;
    if (!flash) throw new DfuError("open", "the device reports no internal or external flash");
    return { regions, flash, transferSize: await reader.transferSize() };
  }

  private async selectAlternate(alternateSetting: number): Promise<void> {
    const entry = this.device.configuration?.interfaces.find((candidate) => candidate.interfaceNumber === DFU_INTERFACE);
    // The Configurator never selects an alternate, so only do it for a region that needs it.
    if ((entry?.alternate.alternateSetting ?? 0) !== alternateSetting) {
      await this.device.selectAlternateInterface(DFU_INTERFACE, alternateSetting);
    }
  }

  private get transferSize(): number {
    return this.layout?.transferSize ?? DEFAULT_TRANSFER_SIZE;
  }

  private async rawIn(setup: UsbControlSetup, length: number, label: string): Promise<RawInResult> {
    const result = await withTimeout(this.device.controlTransferIn(setup, length), TRANSFER_TIMEOUT_MS, `USB ${label}`);
    const data = result.data ? new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength) : new Uint8Array(0);
    return { status: result.status, data };
  }

  private classSetup(request: number, value: number): UsbControlSetup {
    return { requestType: "class", recipient: "interface", request, value, index: DFU_INTERFACE };
  }

  private async controlIn(request: number, value: number, length: number, label: string): Promise<Uint8Array> {
    let result: RawInResult;
    try {
      result = await this.rawIn(this.classSetup(request, value), length, label);
    } catch (cause) {
      throw new DfuError(this.stage, `USB ${label} failed: ${describeError(cause)}`, undefined, { cause });
    }
    if (result.status !== "ok") throw new DfuError(this.stage, `USB ${label} ended with status ${result.status}`);
    return result.data;
  }

  private async controlOut(request: number, value: number, label: string, data = new Uint8Array(0)): Promise<void> {
    let status: UsbTransferStatus | undefined;
    try {
      const setup = this.classSetup(request, value);
      ({ status } = await withTimeout(this.device.controlTransferOut(setup, data), TRANSFER_TIMEOUT_MS, `USB ${label}`));
    } catch (cause) {
      throw new DfuError(this.stage, `USB ${label} failed: ${describeError(cause)}`, undefined, { cause });
    }
    if (status !== "ok") throw new DfuError(this.stage, `USB ${label} ended with status ${status}`);
  }

  private async getStatus(): Promise<DfuDeviceStatus> {
    const data = await this.controlIn(REQUEST_GETSTATUS, 0, 6, "GETSTATUS");
    if (data.length < 6) throw new DfuError(this.stage, `GETSTATUS returned ${data.length} bytes`);
    this.lastStatus = parseStatus(data);
    return this.lastStatus;
  }

  private async tryGetStatus(): Promise<DfuDeviceStatus | undefined> {
    try {
      return await this.getStatus();
    } catch (error) {
      if (error instanceof DfuError) return undefined;
      throw error;
    }
  }

  private refused(message: string, status: DfuDeviceStatus): DfuError {
    if (status.status === STATUS_ERR_VENDOR && (this.stage === "read" || this.stage === "erase")) {
      return new DfuReadProtectedError(this.stage, status);
    }
    return new DfuError(this.stage, message, status);
  }

  /**
   * Brings the device back to dfuIDLE. The request depends on the state: only dfuERROR
   * may be sent CLRSTATUS, since strict ROMs (STM32C5) STALL it anywhere else.
   *
   * Some H743 Rev.V bootloaders wedge in dfuDNBUSY after a page erase and only recover
   * through the undocumented CLRSTATUS pair STM32CubeProgrammer uses: the first answers
   * errUNKNOWN/dfuERROR, the second OK/dfuIDLE. Only a caller that has already waited out
   * the poll timeout passes busyIsStuck, so an honest bootloader is never sent one.
   */
  private async clearStatus(busyIsStuck = false, attempts = CLEAR_STATUS_ATTEMPTS): Promise<DfuDeviceStatus> {
    for (let attempt = 1; ; attempt++) {
      const status = await this.tryGetStatus();
      if (status?.state === STATE_IDLE) return status;
      if (attempt >= attempts) {
        throw new DfuError(this.stage, `the device did not reach dfuIDLE after ${attempt} attempts`, status);
      }
      await sleep(status?.pollTimeout ?? 0);
      if (status?.state === STATE_DNLOAD_IDLE || status?.state === STATE_UPLOAD_IDLE) {
        await this.controlOut(REQUEST_ABORT, 0, "ABORT");
      } else if (status?.state === STATE_ERROR || (busyIsStuck && status?.state === STATE_DNBUSY)) {
        await this.controlOut(REQUEST_CLRSTATUS, 0, "CLRSTATUS");
      }
    }
  }

  /**
   * A run that died mid-command leaves the ROM bootloader in a DFU state where it STALLs
   * descriptor requests, so it must be returned to dfuIDLE before its layout can be read.
   */
  private async settleInterruptedRun(): Promise<void> {
    try {
      await this.clearStatus(false, SETTLE_ATTEMPTS);
    } catch {
      // Reading the layout next reports a device that really cannot respond.
    }
  }

  /** DNLOAD then GETSTATUS: a device that accepted the block reports dfuDNBUSY and how long to wait. */
  private async download(blockNumber: number, data: Uint8Array<ArrayBuffer>, what: string): Promise<DfuDeviceStatus> {
    await this.controlOut(REQUEST_DNLOAD, blockNumber, "DNLOAD", data);
    const status = await this.getStatus();
    if (status.state !== STATE_DNBUSY) throw this.refused(`${what} was not accepted`, status);
    return status;
  }

  private async loadAddress(address: number): Promise<DfuDeviceStatus> {
    const busy = await this.download(0, addressCommand(COMMAND_SET_ADDRESS, address), `set address ${hexAddress(address)}`);
    await sleep(busy.pollTimeout);
    return this.getStatus();
  }

  private async setAddressPointer(address: number): Promise<void> {
    const status = await this.loadAddress(address);
    if (status.state !== STATE_DNLOAD_IDLE) throw this.refused(`could not set address ${hexAddress(address)}`, status);
  }

  /**
   * Read protection shows up here rather than where ST documents it: the address load of
   * the option bytes fails with errVENDOR, and otherwise reading them fails.
   */
  private async checkReadProtection(optionBytes: DfuMemoryRegion): Promise<void> {
    await this.clearStatus();
    const loaded = await this.loadAddress(optionBytes.startAddress);
    if (loaded.state !== STATE_DNLOAD_IDLE) throw this.refused("could not load the option bytes address", loaded);
    await this.clearStatus();

    let data: Uint8Array;
    try {
      data = await this.controlIn(REQUEST_UPLOAD, FIRST_DATA_BLOCK, optionBytes.totalSize, "UPLOAD");
    } catch (error) {
      throw await this.uploadFailure(optionBytes.startAddress, error);
    }
    const status = await this.getStatus();
    if (status.state !== STATE_UPLOAD_IDLE || data.length !== optionBytes.totalSize) {
      throw new DfuReadProtectedError(this.stage, status);
    }
    await this.clearStatus();
  }

  private async erase(pages: number[]): Promise<void> {
    this.report("erase", 0, pages.length);
    for (const [index, address] of pages.entries()) {
      const busy = await this.download(0, addressCommand(COMMAND_ERASE, address), `erase of page ${hexAddress(address)}`);
      await sleep(busy.pollTimeout);
      await this.confirmErased(address);
      this.report("erase", index + 1, pages.length);
    }
  }

  private async confirmErased(address: number): Promise<void> {
    const status = await this.getStatus();
    if (status.state === STATE_DNBUSY) {
      // H743 Rev.V stays in dfuDNBUSY past the reported delay although the erase has finished.
      await this.clearStatus(true);
      const cleared = await this.getStatus();
      if (cleared.state !== STATE_IDLE) throw this.refused(`page ${hexAddress(address)} did not return to dfuIDLE after erase`, cleared);
    } else if (status.state !== STATE_DNLOAD_IDLE) {
      throw this.refused(`erase of page ${hexAddress(address)} failed`, status);
    }
  }

  private async write(firmware: HexImage): Promise<void> {
    let written = 0;
    this.report("write", 0, firmware.bytesTotal);
    for (const block of firmware.data) {
      for (const window of addressWindows(block.address, block.bytes.length)) {
        // The device is still in dfuDNLOAD-IDLE after the previous DNLOAD, so no abort is needed.
        await this.setAddressPointer(window.address);
        let blockNumber = FIRST_DATA_BLOCK;
        for (let sent = 0; sent < window.length; ) {
          const size = Math.min(this.transferSize, window.length - sent);
          const chunk = block.bytes.slice(window.offset + sent, window.offset + sent + size);
          await this.writeChunk(blockNumber++, chunk, window.address + sent);
          sent += size;
          written += size;
          this.report("write", written, firmware.bytesTotal);
        }
      }
    }
  }

  private async writeChunk(blockNumber: number, chunk: Uint8Array<ArrayBuffer>, address: number): Promise<void> {
    const where = `${chunk.length} bytes at ${hexAddress(address)}`;
    const busy = await this.download(blockNumber, chunk, `write of ${where}`);
    await sleep(busy.pollTimeout);
    const status = await this.getStatus();
    if (status.state !== STATE_DNLOAD_IDLE) throw this.refused(`write of ${where} failed`, status);
  }

  private async verify(firmware: HexImage): Promise<void> {
    let verified = 0;
    this.report("verify", 0, firmware.bytesTotal);
    for (const block of firmware.data) {
      const base = verified;
      const readBack = await this.uploadRange(block.address, block.bytes.length, (done) => {
        this.report("verify", base + done, firmware.bytesTotal);
      });
      const mismatch = block.bytes.findIndex((byte, index) => byte !== readBack[index]);
      if (mismatch !== -1) {
        throw new DfuVerifyError(block.address + mismatch, block.bytes[mismatch]!, readBack[mismatch]!, this.lastStatus);
      }
      verified += block.bytes.length;
    }
  }

  /** Each window: set the pointer, abort to dfuIDLE (UPLOAD is refused from DNLOAD states), then upload. */
  private async uploadRange(address: number, length: number, onProgress: (done: number) => void): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    for (const window of addressWindows(address, length)) {
      await this.clearStatus();
      await this.setAddressPointer(window.address);
      await this.clearStatus();
      let blockNumber = FIRST_DATA_BLOCK;
      for (let received = 0; received < window.length; ) {
        const size = Math.min(this.transferSize, window.length - received);
        result.set(await this.uploadChunk(blockNumber++, size, window.address + received), window.offset + received);
        received += size;
        onProgress(window.offset + received);
      }
    }
    await this.clearStatus();
    return result;
  }

  private async uploadChunk(blockNumber: number, length: number, address: number): Promise<Uint8Array> {
    let data: Uint8Array;
    try {
      data = await this.controlIn(REQUEST_UPLOAD, blockNumber, length, "UPLOAD");
    } catch (error) {
      throw await this.uploadFailure(address, error);
    }
    if (data.length !== length) throw await this.uploadFailure(address, new Error(`short read of ${data.length} of ${length} bytes`));
    return data;
  }

  private async uploadFailure(address: number, cause: unknown): Promise<DfuError> {
    const status = await this.tryGetStatus();
    if (status?.status === STATUS_ERR_VENDOR && (this.stage === "read" || this.stage === "erase")) {
      return new DfuReadProtectedError(this.stage, status, { cause });
    }
    return new DfuError(this.stage, `upload at ${hexAddress(address)} failed: ${describeError(cause)}`, status, { cause });
  }

  /**
   * A zero-length DNLOAD followed by GETSTATUS is what makes an STM32 jump to the address
   * pointer. The device can vanish while answering that GETSTATUS, so its result is ignored.
   */
  private async leaveDfu(address: number): Promise<void> {
    this.stage = "leave";
    try {
      await this.clearStatus();
      await this.setAddressPointer(address);
      await this.controlOut(REQUEST_DNLOAD, 0, "DNLOAD");
      await this.tryGetStatus();
    } finally {
      await this.disconnect();
    }
  }
}
