import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DfuAddressError,
  DfuError,
  DfuFlasher,
  DfuReadProtectedError,
  DfuRefusedError,
  DfuVerifyError,
  parseDfuMemoryString,
  type DfuProgress,
} from "../src/dfu/flasher.js";
import type { UsbControlSetup, UsbDeviceLike, UsbInTransfer, UsbOutTransfer } from "../src/dfu/usb-device.js";
import { DEMO_IMAGE_MARKER } from "../src/firmware/demo-image.js";
import type { HexImage } from "../src/firmware/hex.js";

const DNLOAD = 1;
const UPLOAD = 2;
const GETSTATUS = 3;
const CLRSTATUS = 4;
const ABORT = 6;

const dfuIDLE = 2;
const dfuDNLOAD_SYNC = 3;
const dfuDNBUSY = 4;
const dfuDNLOAD_IDLE = 5;
const dfuMANIFEST_SYNC = 6;
const dfuMANIFEST = 7;
const dfuUPLOAD_IDLE = 9;
const dfuERROR = 10;

const OK = 0;
const errWRITE = 3;
const errERASE = 4;
const errADDRESS = 8;
const errVENDOR = 0x0b;
const errUNKNOWN = 0x0e;
const errSTALLEDPKT = 0x0f;

/** What the fake's flash holds before anything erases it, so unerased writes corrupt visibly. */
const OLD_CONTENT = 0xa5;
const FLASH_BASE = 0x08000000;
const OPTION_BYTES_BASE = 0x1fff0000;

interface FakePage {
  address: number;
  size: number;
}

interface FakeOptions {
  strings: string[];
  pages: FakePage[];
  transferSize?: number;
  commandPollMs?: number;
  erasePollMs?: number;
  writePollMs?: number;
  /** "address" refuses address loads, the signature the Configurator documents; "upload" only refuses UPLOAD. */
  protection?: "address" | "upload";
  wedgedErasePages?: number[];
  silentlySkippedErasePages?: number[];
  failedErasePages?: Map<number, number>;
  failedWriteAddress?: number;
  claimFailures?: number;
  openError?: Error;
  /** wTransferSize in the descriptor, when it should differ from the size the device really uses. */
  reportedTransferSize?: number;
  /** Descriptors placed before the DFU interface, to model a composite device. */
  configPrefix?: number[];
  /** The device starts in dfuDNBUSY and settles after this many polls. */
  busyPollsAtStart?: number;
  /** Every UPLOAD returns at most this many bytes. */
  truncateUploads?: number;
  vanishDuringLeaveStatus?: boolean;
  /** Standard requests STALL outside dfuIDLE, as seen on an F722 ROM after an aborted erase. */
  stallDescriptorsUntilIdle?: boolean;
}

interface FakeInterface {
  interfaceNumber: number;
  alternate: { alternateSetting: number };
}

/**
 * An in-memory STM32 DFU bootloader. It follows the DFU state machine strictly: a request
 * that is illegal in the current state STALLs and lands in dfuERROR, as the STM32C5 ROM
 * does, so a flasher sloppy about states fails here. Programming can only clear bits and
 * only an erase sets them, so writing to unerased flash corrupts it like the real thing.
 */
class FakeDfuDevice implements UsbDeviceLike {
  configuration: { interfaces: FakeInterface[] } | null = null;
  state = dfuIDLE;
  status = OK;
  pointer = 0;
  private pending: { block: number; payload: Uint8Array } | undefined;
  private afterBusy = { state: dfuDNLOAD_IDLE, status: OK };
  private busyUntil = 0;
  private wedged = false;
  private gone = false;
  private readonly memory = new Map<number, Uint8Array>();
  private readonly configBlob: Uint8Array;
  private readonly transferSize: number;

  readonly erased: number[] = [];
  readonly addressLoads: number[] = [];
  readonly downloads: { block: number; length: number }[] = [];
  readonly uploads: { block: number; length: number; stateBefore: number }[] = [];
  readonly requests: number[] = [];
  readonly selectedAlternates: number[] = [];
  readonly clearStatusRequests: number[] = [];
  standaloneFunctionalRequests = 0;
  earlyPolls = 0;
  strayClearStatus = 0;
  unprotectCommands = 0;
  left = false;
  leftAt: number | undefined;
  released = 0;
  closed = 0;
  private claimFailuresLeft: number;
  private busyPollsLeft: number;

  constructor(private readonly options: FakeOptions) {
    this.transferSize = options.transferSize ?? 2048;
    this.configBlob = this.buildConfigBlob();
    this.claimFailuresLeft = options.claimFailures ?? 0;
    this.busyPollsLeft = options.busyPollsAtStart ?? 0;
    if (this.busyPollsLeft > 0) this.state = dfuDNBUSY;
  }

  open(): Promise<void> {
    return this.options.openError ? Promise.reject(this.options.openError) : Promise.resolve();
  }

  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }

  selectConfiguration(): Promise<void> {
    this.configuration = { interfaces: [{ interfaceNumber: 0, alternate: { alternateSetting: 0 } }] };
    return Promise.resolve();
  }

  claimInterface(): Promise<void> {
    if (this.claimFailuresLeft > 0) {
      this.claimFailuresLeft--;
      return Promise.reject(new Error("Unable to claim interface."));
    }
    return Promise.resolve();
  }

  releaseInterface(): Promise<void> {
    this.released++;
    return this.gone ? Promise.reject(new Error("The device was disconnected.")) : Promise.resolve();
  }

  selectAlternateInterface(_interfaceNumber: number, alternateSetting: number): Promise<void> {
    this.selectedAlternates.push(alternateSetting);
    this.configuration!.interfaces[0]!.alternate = { alternateSetting };
    return Promise.resolve();
  }

  controlTransferIn(setup: UsbControlSetup, length: number): Promise<UsbInTransfer> {
    if (this.gone) return Promise.reject(new Error("The device was disconnected."));
    if (setup.requestType === "standard") {
      if (this.options.stallDescriptorsUntilIdle && this.state !== dfuIDLE) return Promise.resolve({ status: "stall" });
      return Promise.resolve(this.standardIn(setup, length));
    }
    this.requests.push(setup.request);
    if (setup.request === GETSTATUS) return this.getStatus();
    if (setup.request === UPLOAD) return Promise.resolve(this.upload(setup.value, length));
    return Promise.resolve(this.stall());
  }

  controlTransferOut(setup: UsbControlSetup, data: Uint8Array<ArrayBuffer> = new Uint8Array(0)): Promise<UsbOutTransfer> {
    if (this.gone) return Promise.reject(new Error("The device was disconnected."));
    this.requests.push(setup.request);
    switch (setup.request) {
      case DNLOAD:
        return Promise.resolve(this.dnload(setup.value, data));
      case CLRSTATUS:
        return Promise.resolve(this.clearStatus());
      case ABORT:
        return Promise.resolve(this.abort());
      default:
        return Promise.resolve(this.stall());
    }
  }

  /** Models the board being put back into the bootloader after leaving DFU. */
  reenterDfu(): void {
    this.gone = false;
    this.left = false;
    this.state = dfuIDLE;
    this.status = OK;
  }

  /** Reads flash directly, bypassing the protocol. */
  peek(address: number, length: number): Uint8Array {
    const result = new Uint8Array(length);
    this.eachSegment(address, length, (page, pageOffset, offset, size) => {
      result.set(this.pageBytes(page).subarray(pageOffset, pageOffset + size), offset);
    });
    return result;
  }

  /** Writes flash directly, bypassing the protocol. */
  poke(address: number, bytes: Uint8Array): void {
    this.eachSegment(address, bytes.length, (page, pageOffset, offset, size) => {
      this.pageBytes(page).set(bytes.subarray(offset, offset + size), pageOffset);
    });
  }

  private pageAt(address: number): FakePage | undefined {
    return this.options.pages.find((page) => address >= page.address && address < page.address + page.size);
  }

  private pageBytes(page: FakePage): Uint8Array {
    let bytes = this.memory.get(page.address);
    if (!bytes) {
      bytes = new Uint8Array(page.size).fill(OLD_CONTENT);
      this.memory.set(page.address, bytes);
    }
    return bytes;
  }

  private eachSegment(address: number, length: number, visit: (page: FakePage, pageOffset: number, offset: number, size: number) => void): boolean {
    for (let offset = 0; offset < length; ) {
      const page = this.pageAt(address + offset);
      if (!page) return false;
      const pageOffset = address + offset - page.address;
      const size = Math.min(page.size - pageOffset, length - offset);
      visit(page, pageOffset, offset, size);
      offset += size;
    }
    return true;
  }

  private buildConfigBlob(): Uint8Array {
    const size = this.options.reportedTransferSize ?? this.transferSize;
    const prefix = this.options.configPrefix ?? [];
    const interfaces = this.options.strings.flatMap((_, index) => [9, 4, 0, index, 0, 0xfe, 1, 2, index + 1]);
    const functional = [9, 0x21, 0x0b, 0xff, 0x00, size & 0xff, size >> 8, 0x1a, 0x01];
    const total = 9 + prefix.length + interfaces.length + functional.length;
    return Uint8Array.from([9, 2, total & 0xff, total >> 8, 1, 1, 0, 0xc0, 50, ...prefix, ...interfaces, ...functional]);
  }

  private stringDescriptor(index: number): Uint8Array {
    if (index === 0) return Uint8Array.of(4, 3, 0x09, 0x04);
    const text = this.options.strings[index - 1] ?? "";
    return Uint8Array.from([2 + text.length * 2, 3, ...[...text].flatMap((char) => [char.charCodeAt(0), 0])]);
  }

  private standardIn(setup: UsbControlSetup, length: number): UsbInTransfer {
    let bytes: Uint8Array | undefined;
    if (setup.value === 0x0200) bytes = this.configBlob;
    else if (setup.value >> 8 === 3) bytes = this.stringDescriptor(setup.value & 0xff);
    if (setup.value === 0x2100) this.standaloneFunctionalRequests++;
    return bytes ? this.inResult(bytes.subarray(0, length)) : { status: "stall" };
  }

  private inResult(bytes: Uint8Array): UsbInTransfer {
    const copy = bytes.slice();
    return { status: "ok", data: new DataView(copy.buffer, copy.byteOffset, copy.byteLength) };
  }

  private statusReply(status: number, pollMs: number, state: number): UsbInTransfer {
    return this.inResult(Uint8Array.of(status, pollMs & 0xff, (pollMs >> 8) & 0xff, (pollMs >> 16) & 0xff, state, 0));
  }

  private stall(status = errSTALLEDPKT): UsbInTransfer & UsbOutTransfer {
    this.state = dfuERROR;
    this.status = status;
    return { status: "stall" };
  }

  private getStatus(): Promise<UsbInTransfer> {
    if (this.state === dfuDNLOAD_SYNC) {
      const pollMs = this.execute();
      this.state = dfuDNBUSY;
      this.busyUntil = Date.now() + pollMs;
      return Promise.resolve(this.statusReply(OK, pollMs, dfuDNBUSY));
    }
    if (this.state === dfuDNBUSY) {
      if (this.busyPollsLeft > 0) {
        if (--this.busyPollsLeft === 0) this.state = dfuIDLE;
        return Promise.resolve(this.statusReply(OK, 0, dfuDNBUSY));
      }
      if (this.wedged) return Promise.resolve(this.statusReply(OK, 1, dfuDNBUSY));
      if (Date.now() < this.busyUntil) {
        this.earlyPolls++;
        return Promise.resolve(this.statusReply(OK, 1, dfuDNBUSY));
      }
      this.state = this.afterBusy.state;
      this.status = this.afterBusy.status;
    } else if (this.state === dfuMANIFEST_SYNC) {
      this.left = true;
      this.leftAt = this.pointer;
      this.gone = true;
      if (this.options.vanishDuringLeaveStatus) return Promise.reject(new Error("The device was disconnected."));
      return Promise.resolve(this.statusReply(OK, 0, dfuMANIFEST));
    }
    return Promise.resolve(this.statusReply(this.status, 0, this.state));
  }

  private dnload(block: number, payload: Uint8Array): UsbOutTransfer {
    if (payload.length === 0) {
      if (this.state !== dfuDNLOAD_IDLE) return this.stall();
      this.state = dfuMANIFEST_SYNC;
      return { status: "ok" };
    }
    if (this.state !== dfuIDLE && this.state !== dfuDNLOAD_IDLE) return this.stall();
    this.downloads.push({ block, length: payload.length });
    this.pending = { block, payload: payload.slice() };
    this.state = dfuDNLOAD_SYNC;
    return { status: "ok" };
  }

  private clearStatus(): UsbOutTransfer {
    this.clearStatusRequests.push(this.state);
    if (this.wedged) {
      this.wedged = false;
      this.state = dfuERROR;
      this.status = errUNKNOWN;
      return { status: "ok" };
    }
    if (this.state !== dfuERROR) {
      this.strayClearStatus++;
      return this.stall();
    }
    this.state = dfuIDLE;
    this.status = OK;
    return { status: "ok" };
  }

  private abort(): UsbOutTransfer {
    if (this.state !== dfuIDLE && this.state !== dfuDNLOAD_IDLE && this.state !== dfuUPLOAD_IDLE) return this.stall();
    this.state = dfuIDLE;
    return { status: "ok" };
  }

  private fail(status: number): void {
    this.afterBusy = { state: dfuERROR, status };
  }

  private execute(): number {
    const { block, payload } = this.pending!;
    this.afterBusy = { state: dfuDNLOAD_IDLE, status: OK };
    if (block === 0) return this.executeCommand(payload);
    if (block === 1) {
      this.fail(errSTALLEDPKT);
      return 0;
    }

    const address = this.pointer + (block - 2) * this.transferSize;
    if (this.options.protection === "address") {
      this.fail(errVENDOR);
    } else if (address === this.options.failedWriteAddress) {
      this.fail(errWRITE);
    } else {
      const inRange = this.eachSegment(address, payload.length, (page, pageOffset, offset, size) => {
        const bytes = this.pageBytes(page);
        for (let i = 0; i < size; i++) bytes[pageOffset + i]! &= payload[offset + i]!;
      });
      if (!inRange) this.fail(errADDRESS);
    }
    return this.options.writePollMs ?? 0;
  }

  private executeCommand(payload: Uint8Array): number {
    const address = (payload[1]! | (payload[2]! << 8) | (payload[3]! << 16) | (payload[4]! << 24)) >>> 0;
    switch (payload[0]) {
      case 0x21:
        this.addressLoads.push(address);
        if (this.options.protection === "address") this.fail(errVENDOR);
        else if (!this.pageAt(address)) this.fail(errADDRESS);
        else this.pointer = address;
        return this.options.commandPollMs ?? 0;
      case 0x41: {
        this.erased.push(address);
        const failure = this.options.failedErasePages?.get(address);
        const page = this.pageAt(address);
        if (failure !== undefined) this.fail(failure);
        else if (this.options.protection === "address") this.fail(errVENDOR);
        else if (!page) this.fail(errADDRESS);
        else if (!this.options.silentlySkippedErasePages?.includes(address)) this.pageBytes(page).fill(0xff);
        if (this.options.wedgedErasePages?.includes(address)) this.wedged = true;
        return this.options.erasePollMs ?? 0;
      }
      case 0x92:
        this.unprotectCommands++;
        return 0;
      default:
        this.fail(errSTALLEDPKT);
        return 0;
    }
  }

  private upload(block: number, length: number): UsbInTransfer {
    this.uploads.push({ block, length, stateBefore: this.state });
    if (this.state !== dfuIDLE && this.state !== dfuUPLOAD_IDLE) return this.stall();
    if (block < 2) return this.stall();
    if (this.options.protection) return this.stall(errVENDOR);
    const address = this.pointer + (block - 2) * this.transferSize;
    const bytes = new Uint8Array(length);
    const inRange = this.eachSegment(address, length, (page, pageOffset, offset, size) => {
      bytes.set(this.pageBytes(page).subarray(pageOffset, pageOffset + size), offset);
    });
    if (!inRange) return this.stall(errADDRESS);
    this.state = dfuUPLOAD_IDLE;
    return this.inResult(bytes.subarray(0, this.options.truncateUploads ?? length));
  }
}

const F722_FLASH_STRING = "@Internal Flash  /0x08000000/04*016Kg,01*64Kg,03*128Kg";
const F722_OPTION_BYTES_STRING = "@Option Bytes  /0x1FFF0000/01*032 e";

function pagesOf(base: number, ...runs: [count: number, size: number][]): FakePage[] {
  const pages: FakePage[] = [];
  let address = base;
  for (const [count, size] of runs) {
    for (let i = 0; i < count; i++) {
      pages.push({ address, size });
      address += size;
    }
  }
  return pages;
}

const F722_PAGES = pagesOf(FLASH_BASE, [4, 16 * 1024], [1, 64 * 1024], [3, 128 * 1024]);

function f722(options: Partial<FakeOptions> = {}): FakeDfuDevice {
  return new FakeDfuDevice({
    strings: [F722_FLASH_STRING, F722_OPTION_BYTES_STRING],
    pages: [...F722_PAGES, { address: OPTION_BYTES_BASE, size: 32 }],
    ...options,
  });
}

function pattern(length: number, seed = 3): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0x7f);
}

function image(...blocks: [address: number, length: number, seed?: number][]): HexImage {
  const data = blocks.map(([address, length, seed]) => ({ address, bytes: pattern(length, seed) }));
  return { data, bytesTotal: data.reduce((sum, block) => sum + block.bytes.length, 0) };
}

function setup(device: FakeDfuDevice): { flasher: DfuFlasher; progress: DfuProgress[] } {
  const progress: DfuProgress[] = [];
  return { flasher: new DfuFlasher(device, (update) => progress.push(update)), progress };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("memory layout", () => {
  it("parses an F722 layout from the alternate-setting strings", async () => {
    const { flasher } = setup(f722());
    const layout = await flasher.open();

    expect(layout.flash).toEqual({
      name: "Internal Flash",
      alternateSetting: 0,
      startAddress: 0x08000000,
      totalSize: 512 * 1024,
      sectors: [
        { startAddress: 0x08000000, pageCount: 4, pageSize: 16 * 1024, totalSize: 64 * 1024 },
        { startAddress: 0x08010000, pageCount: 1, pageSize: 64 * 1024, totalSize: 64 * 1024 },
        { startAddress: 0x08020000, pageCount: 3, pageSize: 128 * 1024, totalSize: 384 * 1024 },
      ],
    });
    expect(layout.regions.option_bytes).toMatchObject({ startAddress: OPTION_BYTES_BASE, totalSize: 32, alternateSetting: 1 });
    expect(layout.transferSize).toBe(2048);
  });

  it("reads the transfer size from the configuration descriptor without a standalone request", async () => {
    const device = f722({ transferSize: 1024 });
    const layout = await setup(device).flasher.open();
    expect(layout.transferSize).toBe(1024);
    expect(device.standaloneFunctionalRequests).toBe(0);
  });

  it("falls back to the default transfer size when the descriptor reports zero", async () => {
    const device = f722({ reportedTransferSize: 0 });
    const layout = await setup(device).flasher.open();
    expect(layout.transferSize).toBe(2048);
    expect(device.standaloneFunctionalRequests).toBe(1);
  });

  it("ignores a HID descriptor, which shares the DFU functional descriptor's type", async () => {
    const hid = [9, 4, 1, 0, 1, 0x03, 0, 0, 0, 9, 0x21, 0x11, 0x01, 0x00, 0x22, 0x00, 0x1b, 0x00];
    const device = f722({ configPrefix: hid, transferSize: 1024 });
    const layout = await setup(device).flasher.open();
    expect(layout.transferSize).toBe(1024);
  });

  it("selects the configuration when none is active and claims without touching the alternate", async () => {
    const device = f722();
    await setup(device).flasher.open();
    expect(device.configuration).not.toBeNull();
    expect(device.selectedAlternates).toEqual([]);
  });

  it("selects the alternate setting of a flash that is not alternate 0", async () => {
    const device = f722({ strings: [F722_OPTION_BYTES_STRING, F722_FLASH_STRING] });
    const layout = await setup(device).flasher.open();
    expect(layout.flash.alternateSetting).toBe(1);
    expect(device.selectedAlternates).toEqual([1]);
  });

  it("skips regions it cannot parse and keeps the flash", async () => {
    const device = f722({ strings: [F722_FLASH_STRING, "@Weird Region /0x1FFF0000/garbage", "@Truncated /0x1FFF0000", ""] });
    const layout = await setup(device).flasher.open();
    expect(Object.keys(layout.regions)).toEqual(["internal_flash"]);
  });

  it("raises a typed open error when no flash is reported", async () => {
    const device = f722({ strings: [F722_OPTION_BYTES_STRING] });
    const error = await caught(setup(device).flasher.open());
    expect(error).toBeInstanceOf(DfuError);
    expect(error).toMatchObject({ stage: "open" });
    expect(device.closed).toBe(1);
  });

  it("explains an access-denied open", async () => {
    const denied = Object.assign(new Error("Access denied."), { name: "SecurityError" });
    const error = await caught(setup(f722({ openError: denied })).flasher.open());
    expect(error).toMatchObject({ stage: "open", cause: denied });
    expect((error as Error).message).toMatch(/denied access/);
  });

  it("retries while the interface is busy", async () => {
    vi.useFakeTimers();
    const device = f722({ claimFailures: 2 });
    const opening = setup(device).flasher.open();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(opening).resolves.toMatchObject({ transferSize: 2048 });
  });

  it("corrects the strings known to be wrong on real bootloaders", () => {
    const h750 = parseDfuMemoryString("@External Flash /0x90000000/1001*128Kg,3*128Kg,20*128Ka");
    expect(h750?.sectors.map((sector) => sector.pageCount)).toEqual([998, 1, 4, 21]);
    expect(parseDfuMemoryString("@InternalFlash /0x08000000/04*016Kg")?.name).toBe("Internal Flash");
    expect(parseDfuMemoryString("@Option byte   /0x1FFFC000/01*512 g")).toMatchObject({ name: "Option bytes", totalSize: 512 });
  });

  it("drops the second bank of a G474 option-bytes string", () => {
    const region = parseDfuMemoryString("@Option Bytes   /0x1FFF7800/01*048 e/0x1FFFF800/01*048 e");
    expect(region).toMatchObject({ startAddress: 0x1fff7800, totalSize: 48 });
  });

  it("understands megabyte pages", () => {
    expect(parseDfuMemoryString("@Internal Flash /0x08000000/02*001Mg")?.totalSize).toBe(2 * 1024 * 1024);
  });
});

describe("recovering an interrupted run", () => {
  it("returns a bootloader left mid-command to idle before reading its layout", async () => {
    const device = f722({ stallDescriptorsUntilIdle: true });
    device.state = dfuDNLOAD_IDLE;
    const { flasher } = setup(device);
    await expect(flasher.open()).resolves.toMatchObject({ transferSize: 2048 });
    expect(device.state).toBe(dfuIDLE);
  });

  it("clears an error state left by the previous run", async () => {
    const device = f722({ stallDescriptorsUntilIdle: true });
    device.state = dfuERROR;
    const { flasher } = setup(device);
    await expect(flasher.open()).resolves.toMatchObject({ transferSize: 2048 });
  });
});

describe("flashing", () => {
  it("erases only the sectors the firmware touches and leaves the rest alone", async () => {
    const device = f722();
    const untouched = pattern(32, 9);
    device.poke(FLASH_BASE, untouched);
    const { flasher } = setup(device);
    await flasher.open();

    // Page 1 fully, and a block that spills from page 2 into page 3.
    await flasher.flash(image([FLASH_BASE + 0x4000, 0x1000], [FLASH_BASE + 0xbff0, 0x20]));

    expect(device.erased).toEqual([FLASH_BASE + 0x4000, FLASH_BASE + 0x8000, FLASH_BASE + 0xc000]);
    expect(device.peek(FLASH_BASE, 32)).toEqual(untouched);
    expect(device.peek(FLASH_BASE + 0x10000, 16)).toEqual(new Uint8Array(16).fill(OLD_CONTENT));
  });

  it("erases every page in a full chip erase", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    await flasher.flash(image([FLASH_BASE, 16]), { fullChipErase: true });
    expect(device.erased).toEqual(F722_PAGES.map((page) => page.address));
  });

  it("writes, verifies and leaves DFU at the firmware's start address", async () => {
    const device = f722();
    const { flasher, progress } = setup(device);
    const firmware = image([FLASH_BASE, 6000]);
    await flasher.open();
    await flasher.flash(firmware);

    expect(device.peek(FLASH_BASE, 6000)).toEqual(firmware.data[0]!.bytes);
    expect(device.left).toBe(true);
    expect(device.leftAt).toBe(FLASH_BASE);
    expect(device.released).toBe(1);
    expect(device.closed).toBe(1);
    expect(device.strayClearStatus).toBe(0);

    expect(device.downloads.filter((download) => download.block !== 0)).toEqual([
      { block: 2, length: 2048 },
      { block: 3, length: 2048 },
      { block: 4, length: 1904 },
    ]);
    const stages = [...new Set(progress.map((update) => update.stage))];
    expect(stages).toEqual(["erase", "write", "verify"]);
    expect(progress.at(-1)).toEqual({ stage: "verify", done: 6000, total: 6000 });
    expect(progress.find((update) => update.stage === "erase" && update.done === 1)).toEqual({ stage: "erase", done: 1, total: 1 });
  });

  it("handles firmware that is several separated blocks", async () => {
    const device = f722();
    const { flasher } = setup(device);
    const firmware = image([FLASH_BASE + 0x100, 512, 1], [FLASH_BASE + 0x20000, 4096, 2]);
    await flasher.open();
    await flasher.flash(firmware);
    expect(device.peek(FLASH_BASE + 0x100, 512)).toEqual(firmware.data[0]!.bytes);
    expect(device.peek(FLASH_BASE + 0x20000, 4096)).toEqual(firmware.data[1]!.bytes);
    expect(device.leftAt).toBe(FLASH_BASE + 0x100);
  });

  it("loads a new address at each 64 KiB boundary, as the Configurator's split images did", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    await flasher.flash(image([FLASH_BASE + 0xf800, 0x1000]));

    expect(device.addressLoads).toEqual([
      OPTION_BYTES_BASE,
      FLASH_BASE + 0xf800,
      FLASH_BASE + 0x10000,
      FLASH_BASE + 0xf800,
      FLASH_BASE + 0x10000,
      FLASH_BASE + 0xf800,
    ]);
    expect(device.downloads.filter((download) => download.block !== 0).map((download) => download.block)).toEqual([2, 2]);
  });

  it("detects a verify failure caused by writing to unerased flash, and does not leave DFU", async () => {
    const device = f722({ silentlySkippedErasePages: [FLASH_BASE] });
    const { flasher } = setup(device);
    const firmware = image([FLASH_BASE, 1024]);
    await flasher.open();

    const error = await caught(flasher.flash(firmware));

    expect(error).toBeInstanceOf(DfuVerifyError);
    expect(error).toMatchObject({ stage: "verify", address: FLASH_BASE, status: { statusName: "OK", stateName: "dfuIDLE" } });
    expect((error as DfuVerifyError).actual).toBe(firmware.data[0]!.bytes[0]! & OLD_CONTENT);
    expect((error as DfuVerifyError).expected).toBe(firmware.data[0]!.bytes[0]);
    expect(device.left).toBe(false);
    expect(device.closed).toBe(1);
  });

  it("names the stage and status when an erase fails", async () => {
    const device = f722({ failedErasePages: new Map([[FLASH_BASE, errERASE]]) });
    const { flasher } = setup(device);
    await flasher.open();

    const error = await caught(flasher.flash(image([FLASH_BASE, 16])));

    expect(error).toBeInstanceOf(DfuError);
    expect(error).toMatchObject({ stage: "erase", status: { statusName: "errERASE", stateName: "dfuERROR" } });
    expect((error as Error).message).toMatch(/erase.*errERASE.*dfuERROR/);
    expect(device.left).toBe(false);
  });

  it("names the stage and status when a write fails", async () => {
    const device = f722({ failedWriteAddress: FLASH_BASE + 2048 });
    const { flasher } = setup(device);
    await flasher.open();

    const error = await caught(flasher.flash(image([FLASH_BASE, 4096])));

    expect(error).toMatchObject({ stage: "write", status: { statusName: "errWRITE" } });
    expect(device.left).toBe(false);
  });

  it("refuses firmware outside the flash before touching the device, and stays open", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    const requestsBefore = device.requests.length;

    await expect(flasher.flash(image([0x20000000, 16]))).rejects.toBeInstanceOf(DfuAddressError);
    // Starts part way through the last sector and runs past the end of the flash.
    await expect(flasher.flash(image([FLASH_BASE + 0x7f000, 0x2000]))).rejects.toBeInstanceOf(DfuAddressError);
    await expect(flasher.flash(image())).rejects.toBeInstanceOf(DfuAddressError);

    expect(device.requests).toHaveLength(requestsBefore);
    expect(device.closed).toBe(0);
    await flasher.flash(image([FLASH_BASE, 16]));
    expect(device.left).toBe(true);
  });

  it("refuses the demo's stand-in image before touching the device, and stays open", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    const requestsBefore = device.requests.length;

    const demo = image([FLASH_BASE, 0x400]);
    demo.data[0]!.bytes.set(new TextEncoder().encode(DEMO_IMAGE_MARKER), 0x200);
    const error = await caught(flasher.flash(demo));
    expect(error).toBeInstanceOf(DfuRefusedError);
    expect((error as Error).message).toContain("demo's stand-in");

    expect(device.requests).toHaveLength(requestsBefore);
    expect(device.closed).toBe(0);
    expect(device.left).toBe(false);
    await flasher.flash(image([FLASH_BASE, 16]));
    expect(device.left).toBe(true);
  });

  it("waits out bwPollTimeout before polling again", async () => {
    vi.useFakeTimers();
    const device = f722({ commandPollMs: 5, erasePollMs: 300, writePollMs: 20 });
    const { flasher } = setup(device);
    const started = Date.now();

    const run = (async () => {
      await flasher.open();
      await flasher.flash(image([FLASH_BASE, 4096]));
    })();
    await vi.runAllTimersAsync();
    await run;

    expect(device.earlyPolls).toBe(0);
    expect(device.left).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(340);
  });

  it("rides out a slow dfuDNBUSY without sending CLRSTATUS", async () => {
    const device = f722({ busyPollsAtStart: 5 });
    const { flasher } = setup(device);
    await flasher.open();
    await flasher.flash(image([FLASH_BASE, 16]));
    expect(device.clearStatusRequests).toEqual([]);
    expect(device.left).toBe(true);
  });

  it("refuses a second operation while one is running", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    const running = flasher.flash(image([FLASH_BASE, 16]));
    await expect(flasher.readFlash(FLASH_BASE, 16)).rejects.toThrow(/already in progress/);
    await running;
  });

  it("carries on when a progress handler throws", async () => {
    const device = f722();
    const flasher = new DfuFlasher(device, () => {
      throw new Error("UI bug");
    });
    await flasher.open();
    await flasher.flash(image([FLASH_BASE, 16]));
    expect(device.left).toBe(true);
  });
});

describe("STM32H7 behaviour", () => {
  const H743_STRING = "@Internal Flash  /0x08000000/16*128Kg";

  function h743(options: Partial<FakeOptions> = {}): FakeDfuDevice {
    return new FakeDfuDevice({
      strings: [H743_STRING],
      pages: pagesOf(FLASH_BASE, [16, 128 * 1024]),
      transferSize: 1024,
      ...options,
    });
  }

  it("recovers an erase wedged in dfuDNBUSY with the CLRSTATUS pair", async () => {
    const device = h743({ wedgedErasePages: [FLASH_BASE + 0x20000], erasePollMs: 1 });
    const { flasher } = setup(device);
    const firmware = image([FLASH_BASE, 0x40000]);
    await flasher.open();
    await flasher.flash(firmware);

    expect(device.erased).toEqual([FLASH_BASE, FLASH_BASE + 0x20000]);
    expect(device.clearStatusRequests).toEqual([dfuDNBUSY, dfuERROR]);
    expect(device.peek(FLASH_BASE, 0x40000)).toEqual(firmware.data[0]!.bytes);
    expect(device.left).toBe(true);
  });

  it("never sends CLRSTATUS to a bootloader that leaves dfuDNBUSY on its own", async () => {
    const device = h743();
    const { flasher } = setup(device);
    await flasher.open();
    await flasher.flash(image([FLASH_BASE, 2048]));

    expect(device.clearStatusRequests).toEqual([]);
    expect(device.left).toBe(true);
  });

  it("flashes an H750 external flash, correcting its layout and skipping the option-bytes check", async () => {
    const device = new FakeDfuDevice({
      strings: ["@External Flash /0x90000000/1001*128Kg,3*128Kg,20*128Ka"],
      pages: pagesOf(0x90000000, [1024, 128 * 1024]),
      transferSize: 1024,
    });
    const { flasher } = setup(device);
    const firmware = image([0x90100000, 5000]);
    const layout = await flasher.open();
    await flasher.flash(firmware);

    expect(layout.flash.sectors.map((sector) => sector.pageCount)).toEqual([998, 1, 4, 21]);
    expect(device.erased).toEqual([0x90100000]);
    expect(device.peek(0x90100000, 5000)).toEqual(firmware.data[0]!.bytes);
    expect(device.addressLoads).toEqual([0x90100000, 0x90100000, 0x90100000]);
    expect(device.leftAt).toBe(0x90100000);
  });

  it("flashes a bootloader with no option-bytes region, as the STM32C5 ROM has", async () => {
    const device = new FakeDfuDevice({ strings: ["@Internal Flash /0x08000000/64*08Kg"], pages: pagesOf(FLASH_BASE, [64, 8 * 1024]), transferSize: 1024 });
    const { flasher } = setup(device);
    await flasher.open();
    await flasher.flash(image([FLASH_BASE, 4096]));
    expect(device.left).toBe(true);
    expect(device.clearStatusRequests).toEqual([]);
  });
});

describe("readFlash", () => {
  it("round trips what was stored, including across sectors and a 64 KiB boundary", async () => {
    const device = f722({ transferSize: 1024 });
    const stored = pattern(0x3000, 11);
    device.poke(FLASH_BASE + 0xf000, stored);
    const { flasher, progress } = setup(device);
    await flasher.open();

    const read = await flasher.readFlash(FLASH_BASE + 0xf000, 0x3000);

    expect(read).toEqual(stored);
    expect(progress.at(-1)).toEqual({ stage: "read", done: 0x3000, total: 0x3000 });
    expect(device.addressLoads).toEqual([FLASH_BASE + 0xf000, FLASH_BASE + 0x10000]);
    expect(device.state).toBe(dfuIDLE);
  });

  it("sets the pointer, aborts to dfuIDLE and uploads from block 2", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    await flasher.readFlash(FLASH_BASE, 5000);

    expect(device.uploads).toEqual([
      { block: 2, length: 2048, stateBefore: dfuIDLE },
      { block: 3, length: 2048, stateBefore: dfuUPLOAD_IDLE },
      { block: 4, length: 904, stateBefore: dfuUPLOAD_IDLE },
    ]);
    const firstUpload = device.requests.indexOf(UPLOAD);
    expect(device.requests.lastIndexOf(ABORT, firstUpload)).toBeGreaterThan(device.requests.indexOf(DNLOAD));
    expect(device.strayClearStatus).toBe(0);
  });

  it("reads back what flash() wrote after the board re-enters DFU", async () => {
    const device = f722();
    const firmware = image([FLASH_BASE + 0x4000, 9000]);
    const writer = new DfuFlasher(device);
    await writer.open();
    await writer.flash(firmware);

    device.reenterDfu();
    const reader = new DfuFlasher(device);
    await reader.open();

    expect(await reader.readFlash(FLASH_BASE + 0x4000, 9000)).toEqual(firmware.data[0]!.bytes);
  });

  it("raises a typed error when read protection refuses the address load", async () => {
    const device = f722({ protection: "address" });
    const { flasher } = setup(device);
    await flasher.open();

    const error = await caught(flasher.readFlash(FLASH_BASE, 1024));

    expect(error).toBeInstanceOf(DfuReadProtectedError);
    expect(error).toMatchObject({ stage: "read", status: { statusName: "errVENDOR" } });
    expect((error as Error).message).toMatch(/read protected/);
    expect(device.closed).toBe(0);
  });

  it("raises a typed error when read protection refuses the upload", async () => {
    const device = f722({ protection: "upload" });
    const { flasher } = setup(device);
    await flasher.open();

    const error = await caught(flasher.readFlash(FLASH_BASE, 1024));

    expect(error).toBeInstanceOf(DfuReadProtectedError);
    expect(error).toMatchObject({ stage: "read", status: { statusName: "errVENDOR", stateName: "dfuERROR" } });
  });

  it("fails rather than returning padded data when the device sends a short block", async () => {
    const device = f722({ truncateUploads: 100 });
    const { flasher } = setup(device);
    await flasher.open();

    const error = await caught(flasher.readFlash(FLASH_BASE, 1024));

    expect(error).toBeInstanceOf(DfuError);
    expect(error).not.toBeInstanceOf(DfuReadProtectedError);
    expect(error).toMatchObject({ stage: "read", status: { statusName: "OK" } });
    expect((error as Error).message).toMatch(/short read of 100 of 1024 bytes/);
  });

  it("names the failure when an upload fails without read protection", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    device.controlTransferIn = () => Promise.reject(new Error("transfer error"));

    const error = await caught(flasher.readFlash(FLASH_BASE, 16));

    expect(error).toBeInstanceOf(DfuError);
    expect(error).not.toBeInstanceOf(DfuReadProtectedError);
    expect(error).toMatchObject({ stage: "read" });
  });

  it("refuses a range outside the flash without touching the device", async () => {
    const device = f722();
    const { flasher } = setup(device);
    await flasher.open();
    await expect(flasher.readFlash(FLASH_BASE + 512 * 1024 - 4, 8)).rejects.toBeInstanceOf(DfuAddressError);
    await expect(flasher.readFlash(FLASH_BASE - 4, 8)).rejects.toBeInstanceOf(DfuAddressError);
    expect(device.uploads).toHaveLength(0);
  });

  it("requires open() first", async () => {
    const error = await caught(new DfuFlasher(f722()).readFlash(FLASH_BASE, 8));
    expect(error).toBeInstanceOf(DfuError);
    expect((error as Error).message).toMatch(/call open\(\) first/);
  });
});

describe("read protection during flash", () => {
  it("stops before erasing when the option-bytes address load is refused, and never unprotects", async () => {
    const device = f722({ protection: "address" });
    const { flasher } = setup(device);
    await flasher.open();

    const error = await caught(flasher.flash(image([FLASH_BASE, 16])));

    expect(error).toBeInstanceOf(DfuReadProtectedError);
    expect(error).toMatchObject({ stage: "erase", status: { statusName: "errVENDOR" } });
    expect(device.erased).toEqual([]);
    expect(device.unprotectCommands).toBe(0);
    expect(device.left).toBe(false);
  });

  it("stops before erasing when reading the option bytes is refused", async () => {
    const device = f722({ protection: "upload" });
    const { flasher } = setup(device);
    await flasher.open();

    await expect(flasher.flash(image([FLASH_BASE, 16]))).rejects.toBeInstanceOf(DfuReadProtectedError);
    expect(device.erased).toEqual([]);
    expect(device.unprotectCommands).toBe(0);
  });

  it("reports protection during erase on a bootloader without option bytes", async () => {
    const device = new FakeDfuDevice({
      strings: ["@Internal Flash /0x08000000/64*08Kg"],
      pages: pagesOf(FLASH_BASE, [64, 8 * 1024]),
      protection: "address",
    });
    const { flasher } = setup(device);
    await flasher.open();

    const error = await caught(flasher.flash(image([FLASH_BASE, 16])));

    expect(error).toBeInstanceOf(DfuReadProtectedError);
    expect(error).toMatchObject({ stage: "erase" });
    expect(device.unprotectCommands).toBe(0);
  });
});

describe("leave", () => {
  it("leaves DFU alone without flashing", async () => {
    const device = f722();
    await new DfuFlasher(device).leave();

    expect(device.left).toBe(true);
    expect(device.leftAt).toBe(FLASH_BASE);
    expect(device.addressLoads).toEqual([FLASH_BASE]);
    expect(device.erased).toEqual([]);
    expect(device.downloads.filter((download) => download.block !== 0)).toEqual([]);
    expect(device.released).toBe(1);
    expect(device.closed).toBe(1);
  });

  it("leaves after open() and a read", async () => {
    const device = f722();
    const flasher = new DfuFlasher(device);
    await flasher.open();
    await flasher.readFlash(FLASH_BASE, 64);
    await flasher.leave();
    expect(device.left).toBe(true);
    expect(device.state).toBe(dfuMANIFEST_SYNC);
  });

  it("tolerates the device vanishing during the final GETSTATUS", async () => {
    const device = f722({ vanishDuringLeaveStatus: true });
    await expect(new DfuFlasher(device).leave()).resolves.toBeUndefined();
    expect(device.left).toBe(true);
    expect(device.released).toBe(1);
    expect(device.closed).toBe(1);
  });

  it("raises a typed error when the address load fails", async () => {
    const device = f722({ protection: "address" });
    const error = await caught(new DfuFlasher(device).leave());
    expect(error).toMatchObject({ stage: "leave", status: { statusName: "errVENDOR" } });
    expect(device.left).toBe(false);
    expect(device.closed).toBe(1);
  });

  it("releases and closes on close()", async () => {
    const device = f722();
    const flasher = new DfuFlasher(device);
    await flasher.open();
    await flasher.close();
    expect(device.released).toBe(1);
    expect(device.closed).toBe(1);
  });
});
