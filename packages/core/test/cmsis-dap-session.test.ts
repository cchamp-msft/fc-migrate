import { describe, expect, it } from "vitest";
import type { HexBlock } from "../src/firmware/hex.js";
import { CMSIS_DAP_USB_FILTERS, CmsisDapProbe, openCmsisDapG4Session, type CmsisDapOpenOptions } from "../src/cmsis-dap/index.js";
import { MemoryAccessError } from "../src/swd/memory-access.js";
import { SessionError, type G4Session, type SessionErrorKind } from "../src/targets/stm32g4/session.js";
import {
  ALPHA_SCENARIOS,
  SimulatedCmsisDap,
  SimulatedG4,
  VirtualTime,
  plausibleBetaflightImage,
  type AlphaScenarioName,
  type SimulatedCmsisDapOptions,
  type SimulatedG4Options,
} from "../src/testing/index.js";

/** A small image in four blocks: the vector table page, a run across a page boundary, a run across the bank boundary, and an unaligned tail in bank 2. */
function testImage(): HexBlock[] {
  const fill = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff);
  const head = fill(0x100, 1);
  new DataView(head.buffer).setUint32(0, 0x20020000, true);
  new DataView(head.buffer).setUint32(4, 0x08000201, true);
  return [
    { address: 0x08000000, bytes: head },
    { address: 0x08006000, bytes: fill(3001, 2) },
    { address: 0x0803fff0, bytes: fill(0x20, 3) },
    { address: 0x08041003, bytes: fill(13, 4) },
  ];
}

interface Rig {
  chip: SimulatedG4;
  dap: SimulatedCmsisDap;
  time: VirtualTime;
  open(options?: Partial<CmsisDapOpenOptions>): Promise<G4Session>;
}

function rig(name: AlphaScenarioName, options: { chip?: Partial<SimulatedG4Options>; dap?: SimulatedCmsisDapOptions } = {}): Rig {
  const time = new VirtualTime();
  const chip = new SimulatedG4({ ...ALPHA_SCENARIOS[name].chip(), ...options.chip, time });
  const dap = new SimulatedCmsisDap(chip, { recordCommands: true, ...options.dap, time });
  return { chip, dap, time, open: (open = {}) => openCmsisDapG4Session(dap, { mode: "hotplug", time, ...open }) };
}

/** Connects the way the UI does on a board whose firmware holds SWCLK: press, open, release when told. */
async function openHoldingReset(r: Rig): Promise<G4Session> {
  r.chip.pressReset();
  return r.open({
    mode: "holdReset",
    onAttached: () => {
      expect(r.chip.resetHeld).toBe(true);
      r.chip.releaseReset();
    },
  });
}

async function expectSessionError(promise: Promise<unknown>, kind: SessionErrorKind): Promise<SessionError> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(SessionError);
  expect((error as SessionError).kind).toBe(kind);
  return error as SessionError;
}

function getLe32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

interface ApRun {
  /** TAR as set at the start of the DAP_Transfer. */
  tar: number;
  /** DRW accesses that followed it in the same command. */
  words: number;
  writes: { address: number; value: number }[];
}

/** Decodes the recorded DAP_Transfer commands into the memory accesses they made. */
function apRuns(dap: SimulatedCmsisDap): ApRun[] {
  const runs: ApRun[] = [];
  for (const command of dap.commands) {
    if (command[0] !== 0x05) continue;
    let offset = 3;
    let run: ApRun | undefined;
    let tar = 0;
    for (let index = 0; index < command[2]!; index++) {
      const request = command[offset++]!;
      const read = (request & 0x02) !== 0;
      const value = read ? 0 : getLe32(command, offset);
      if (!read) offset += 4;
      if ((request & 0x01) === 0) continue;
      const register = request & 0x0c;
      if (register === 0x4 && !read) {
        tar = value;
        run = { tar, words: 0, writes: [] };
        runs.push(run);
      } else if (register === 0xc && run) {
        if (!read) run.writes.push({ address: tar, value });
        run.words++;
        tar = ((tar & ~0x3ff) | ((tar + 4) & 0x3ff)) >>> 0;
      }
    }
  }
  return runs;
}

function memoryWrites(dap: SimulatedCmsisDap): { address: number; value: number }[] {
  return apRuns(dap).flatMap((run) => run.writes);
}

/** The OPTR values the session wrote. */
function optrWrites(dap: SimulatedCmsisDap): number[] {
  return memoryWrites(dap)
    .filter((write) => write.address === 0x40022020)
    .map((write) => write.value);
}

async function writeImage(session: G4Session, image: HexBlock[]): Promise<void> {
  await session.erase(image, "pages");
  await session.program(image);
  expect(await session.verify(image)).toBeUndefined();
}

function expectImageInFlash(chip: SimulatedG4, image: HexBlock[]): void {
  for (const block of image) expect(chip.readFlash(block.address, block.bytes.length)).toEqual(block.bytes);
}

describe("openCmsisDapG4Session", () => {
  it("finds the CMSIS-DAP interface among the Flipper's serial interfaces and identifies the probe", async () => {
    const r = rig("migratedBetaflight");
    const session = await r.open();
    expect(session.probe).toEqual({ model: "Simulated CMSIS-DAP", firmware: "CMSIS-DAP 2.0.0" });
    expect(r.dap.clockHz).toBe(480_000);
    expect((await session.readAll()).devId).toBe(0x469);
    await session.close();
    expect(r.dap.opened).toBe(false);
  });

  it("refuses a USB serial device with the same IDs, which has no CMSIS-DAP interface, without sending it anything", async () => {
    const r = rig("migratedBetaflight", { dap: { interfaces: "cdc-only" } });
    const error = await expectSessionError(r.open(), "probe-firmware");
    expect(error.message).toContain("0483:5740");
    expect(error.message).toContain("DAP Link app");
    expect(r.dap.commands).toHaveLength(0);
    expect(r.dap.opened).toBe(false);
  });

  it("uses a vendor interface whose name the host cannot read, and skips one named otherwise", async () => {
    const unnamed = rig("migratedBetaflight", { dap: { interfaceName: null } });
    await (await unnamed.open()).close();

    const other = rig("migratedBetaflight", { dap: { interfaceName: "Vendor bootloader" } });
    await expectSessionError(other.open(), "probe-firmware");
  });

  it("refuses a probe without SWD", async () => {
    const r = rig("migratedBetaflight", { dap: { capabilities: 0x02 } });
    const error = await expectSessionError(r.open(), "probe-firmware");
    expect(error.message).toContain("SWD");
    expect(r.dap.opened).toBe(false);
  });

  it("reports a probe lost while opening as usb", async () => {
    const r = rig("migratedBetaflight", { dap: { usbLostAfterCommands: 2 } });
    await expectSessionError(r.open(), "usb");
  });

  it("offers the Flipper Zero and the Raspberry Pi debugprobe in the chooser", () => {
    expect(CMSIS_DAP_USB_FILTERS).toEqual([
      { vendorId: 0x0483, productId: 0x5740 },
      { vendorId: 0x2e8a, productId: 0x000c },
    ]);
  });
});

describe("Alpha scenarios end to end through CMSIS-DAP", () => {
  it("stockAlpha073: hot-plug fails, hold-reset attaches, unlock, write, verify, run", async () => {
    const r = rig("stockAlpha073");
    await expectSessionError(r.open(), "no-target");

    const session = await openHoldingReset(r);
    expect(r.chip.coreState).toBe("halted");
    const before = await session.readAll();
    expect(before).toMatchObject({ devId: 0x469, flashSizeKb: 512, optr: 0xfbeff801 });
    expect(before.flashHead).toBeUndefined();

    await session.removeReadProtection({ clearSwBoot0: false });
    expect(r.chip.optr).toBe(0xfbeff8aa);
    expect(r.chip.counters.oblLaunches).toBe(1);

    const image = testImage();
    await writeImage(session, image);
    expectImageInFlash(r.chip, image);
    await session.resetAndRun();
    expect(r.chip.coreState).toBe("running");
    await session.close();

    expect(optrWrites(r.dap)).toEqual([0xfbeff8aa]);
    expect(r.chip.level2Written).toBe(false);
    expect(r.dap.nrstDriven).toBe(false);
  });

  it("brickedPartialFlash: hot-plug, unlock, mass erase, write", async () => {
    const r = rig("brickedPartialFlash");
    const session = await r.open();
    expect((await session.readAll()).flashHead).toBeUndefined();
    await session.removeReadProtection({ clearSwBoot0: false });
    const image = testImage();
    await session.erase(image, "mass");
    await session.program(image);
    expect(await session.verify(image)).toBeUndefined();
    await session.close();
    expect(r.chip.level2Written).toBe(false);
  });

  it("migratedBetaflight: reads the image and config, reflashes by page and keeps the config", async () => {
    const r = rig("migratedBetaflight");
    const session = await r.open();
    const readings = await session.readAll();
    expect(readings.configMagic).toBe(0xbe);
    expect(readings.flashHead).toEqual(plausibleBetaflightImage()[0]!.bytes.subarray(0, 1024));
    const image = testImage();
    await writeImage(session, image);
    expectImageInFlash(r.chip, image);
    expect((await session.readAll()).configMagic).toBe(0xbe);
    await session.close();
  });

  it("level2 and wiringFault: no-target in either mode", async () => {
    for (const name of ["level2", "wiringFault"] as const) {
      const r = rig(name);
      await expectSessionError(r.open(), "no-target");
      r.chip.pressReset();
      await expectSessionError(r.open({ mode: "holdReset", onAttached: () => r.chip.releaseReset() }), "no-target");
      expect(r.dap.opened).toBe(false);
    }
  });

  it("never drives the probe's reset pin or writes RDP 0xCC across every scenario", async () => {
    for (const name of ["stockAlpha073", "brickedPartialFlash", "oldAlphaSwBoot"] as const) {
      const r = rig(name);
      const session = name === "stockAlpha073" ? await openHoldingReset(r) : await r.open();
      await session.removeReadProtection({ clearSwBoot0: true });
      await session.close();
      expect(optrWrites(r.dap).every((value) => (value & 0xff) !== 0xcc)).toBe(true);
      expect(r.chip.level2Written).toBe(false);
      expect(r.dap.nrstDriven).toBe(false);
    }
  });
});

describe("transfers and failures", () => {
  it("fits every command in one packet and keeps each memory run inside one 1 KB block", async () => {
    for (const packetSize of [64, 512]) {
      const r = rig("migratedBetaflight", { dap: { packetSize } });
      const session = await r.open();
      const unaligned = [{ address: 0x08006002, bytes: r.chip.readFlash(0x08006002, 5000) }];
      expect(await session.verify(unaligned)).toBeUndefined();
      await writeImage(session, testImage());
      await session.close();
      // The simulator throws on a command or reply larger than its packet.
      for (const run of apRuns(r.dap)) expect(Math.floor(run.tar / 1024)).toBe(Math.floor((run.tar + run.words * 4 - 1) / 1024));
      const longest = Math.max(...apRuns(r.dap).map((run) => run.words));
      expect(longest).toBe(packetSize === 64 ? 15 : 127);
    }
  });

  it("clears the sticky error after a bus fault, so the next access works", async () => {
    const time = new VirtualTime();
    const chip = new SimulatedG4({ ...ALPHA_SCENARIOS.brickedPartialFlash.chip(), time });
    const probe = await CmsisDapProbe.open(new SimulatedCmsisDap(chip, { time }), { time });
    await probe.enterSwd();
    const error = await probe.read32(0x08000000).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(MemoryAccessError);
    expect((error as MemoryAccessError).failure).toBe("fault");
    expect((await probe.read32(0xe0042000)) & 0xfff).toBe(0x469);
    await probe.close();
  });

  it("re-attaches after the option-byte relaunch drops the debug port", async () => {
    const r = rig("brickedPartialFlash");
    const session = await r.open();
    await session.removeReadProtection({ clearSwBoot0: false });
    const resets = r.dap.commands.filter((command) => command[0] === 0x12).length;
    expect(resets).toBeGreaterThanOrEqual(2);
    expect((await session.readAll()).optr).toBe(0xfbeff8aa);
    await session.close();
  });

  it("makes a transfer timeout fatal: the device is closed and later calls fail at once", async () => {
    const r = rig("blankAfterErase", { dap: { stallAfterCommands: 20 } });
    const session = await r.open({ transferTimeoutMs: 50 });
    await expectSessionError(session.readAll(), "timeout");
    expect(r.dap.opened).toBe(false);
    const sent = r.dap.commands.length;
    await expectSessionError(session.readAll(), "timeout");
    await expectSessionError(session.program(testImage()), "timeout");
    expect(r.dap.commands.length).toBe(sent);
    await session.close();
  });

  it("makes a lost probe fatal too", async () => {
    const r = rig("blankAfterErase", { dap: { usbLostAfterCommands: 60 } });
    const session = await r.open();
    await expectSessionError(session.program(testImage()), "usb");
    await expectSessionError(session.readAll(), "usb");
    await session.close();
  });
});
