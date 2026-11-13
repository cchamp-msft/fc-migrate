import { describe, expect, it } from "vitest";
import type { HexBlock } from "../src/firmware/hex.js";
import { openStlinkG4Session, STLINK_USB_FILTERS, type StlinkOpenOptions } from "../src/stlink/index.js";
import { SessionError, type G4Session, type SessionErrorKind } from "../src/targets/stm32g4/session.js";
import { createAlphaSimulation, plausibleBetaflightImage, VirtualTime, type AlphaScenarioName, type AlphaSimulation, type AlphaSimulationOptions } from "../src/testing/index.js";

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
  sim: AlphaSimulation;
  time: VirtualTime;
  open(options?: Partial<StlinkOpenOptions>): Promise<G4Session>;
}

function rig(name: AlphaScenarioName, options: AlphaSimulationOptions = {}): Rig {
  const time = new VirtualTime();
  const sim = createAlphaSimulation(name, { ...options, time, probe: { recordFrames: true, ...options.probe } });
  return {
    sim,
    time,
    open: (open = {}) => openStlinkG4Session(sim.probe, { mode: "hotplug", time, ...open }),
  };
}

/** Connects the way the UI does on a board whose firmware holds SWCLK: press, open, release when told. */
async function openHoldingReset(r: Rig): Promise<{ session: G4Session; attachedCalls: number }> {
  let attachedCalls = 0;
  r.sim.chip.pressReset();
  const session = await r.open({
    mode: "holdReset",
    onAttached: () => {
      attachedCalls++;
      expect(r.sim.chip.resetHeld).toBe(true);
      r.sim.chip.releaseReset();
    },
  });
  return { session, attachedCalls };
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

/** The OPTR values the session wrote, from the recorded WRITEDEBUGREG frames. */
function optrWrites(sim: AlphaSimulation): number[] {
  return sim.probe.frames
    .filter((frame) => frame[0] === 0xf2 && frame[1] === 0x35)
    .map((frame) => new DataView(frame.buffer, frame.byteOffset))
    .filter((view) => view.getUint32(2, true) === 0x40022020)
    .map((view) => view.getUint32(6, true));
}

/** Erase pages, program, verify, run: the write half of every migration. */
async function writeImage(session: G4Session, image: HexBlock[]): Promise<void> {
  const progress: [number, number][] = [];
  await session.erase(image, "pages", (done, total) => progress.push([done, total]));
  expect(progress.at(-1)).toEqual([6 * 2048, 6 * 2048]);
  await session.program(image);
  expect(await session.verify(image)).toBeUndefined();
}

function expectImageInFlash(sim: AlphaSimulation, image: HexBlock[]): void {
  for (const block of image) expect(sim.chip.readFlash(block.address, block.bytes.length)).toEqual(block.bytes);
}

function allErased(bytes: Uint8Array | undefined): boolean {
  return bytes !== undefined && bytes.every((byte) => byte === 0xff);
}

describe("openStlinkG4Session", () => {
  it("identifies the probe", async () => {
    const r = rig("blankAfterErase");
    const session = await r.open();
    expect(session.probe).toEqual({ model: "ST-Link/V2", firmware: "V2J39S7", targetVolts: 3.27 });
    await session.close();
    expect(r.sim.probe.opened).toBe(false);
  });

  it("leaves the probe's DFU mode, sets 480 kHz and enters SWD without reset", async () => {
    const r = rig("blankAfterErase");
    const session = await r.open();
    const heads = r.sim.probe.frames.map((frame) => [...frame.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join(" "));
    expect(heads.slice(0, 6)).toEqual(["f1 00 00 00", "f5 00 00 00", "f3 07 00 00", "f7 00 00 00", "f2 43 07 00", "f2 30 a3 00"]);
    await session.close();
  });

  it("works through an ST-Link/V2-1 with its own endpoints", async () => {
    const r = rig("blankAfterErase", { probe: { productId: 0x374b } });
    const session = await r.open({ clockKhz: 1800 });
    expect(session.probe.model).toBe("ST-Link/V2-1");
    expect(session.probe.firmware).toBe("V2J39M27");
    await writeImage(session, testImage());
    await session.close();
  });

  it("refuses probe firmware older than J22", async () => {
    const r = rig("blankAfterErase", { probe: { versionReply: Uint8Array.from([0x25, 0x47, 0x83, 0x04, 0x48, 0x37]) } });
    const error = await expectSessionError(r.open(), "probe-firmware");
    expect(error.message).toContain("V2J21S7");
    expect(r.sim.probe.opened).toBe(false);
  });

  it("refuses a USB device that is not a supported ST-Link", async () => {
    const r = rig("blankAfterErase", { probe: { productId: 0x374e } });
    await expectSessionError(r.open(), "probe-firmware");
  });

  it("reports a probe lost while opening as usb", async () => {
    const r = rig("blankAfterErase", { faults: { usbLostAfterFrames: 2 } });
    await expectSessionError(r.open(), "usb");
  });
});

describe("Alpha scenarios end to end", () => {
  it("stockAlpha073: hot-plug fails, hold-reset attaches, unlock, write, verify, run", async () => {
    const r = rig("stockAlpha073");
    await expectSessionError(r.open(), "no-target");

    const { session, attachedCalls } = await openHoldingReset(r);
    expect(attachedCalls).toBe(1);
    expect(r.sim.chip.coreState).toBe("halted");

    const before = await session.readAll();
    expect(before).toMatchObject({ devId: 0x469, flashSizeKb: 512, optr: 0xfbeff801, uid: "53494d554c41544544303733" });
    expect(before.flashHead).toBeUndefined();
    expect(before.configMagic).toBeUndefined();
    expect(before.wrp1ar).toBe(0xff00ffff);

    await session.removeReadProtection({ clearSwBoot0: false });
    expect(r.sim.chip.optr).toBe(0xfbeff8aa);
    expect(r.sim.chip.counters.oblLaunches).toBe(1);
    const unlocked = await session.readAll();
    expect(unlocked.optr).toBe(0xfbeff8aa);
    expect(allErased(unlocked.flashHead)).toBe(true);
    expect(unlocked.configMagic).toBe(0xff);

    const image = testImage();
    await writeImage(session, image);
    expectImageInFlash(r.sim, image);
    await session.resetAndRun();
    expect(r.sim.chip.coreState).toBe("running");
    expect((await session.readAll()).flashHead!.subarray(0, 0x100)).toEqual(image[0]!.bytes);
    await session.close();

    expect(optrWrites(r.sim)).toEqual([0xfbeff8aa]);
    expect(r.sim.chip.level2Written).toBe(false);
    expect(r.sim.probe.nrstDriven).toBe(false);
  });

  it("stockAlpha073: an unattended demo can release the button automatically", async () => {
    const r = rig("stockAlpha073");
    r.sim.chip.pressReset({ autoReleaseMs: 1500 });
    const session = await r.open({ mode: "holdReset" });
    expect(r.sim.chip.resetHeld).toBe(false);
    expect(r.sim.chip.coreState).toBe("halted");
    await session.close();
    expect(r.sim.chip.coreState).toBe("running");
  });

  it("brickedPartialFlash: hot-plug, unlock, mass erase, write", async () => {
    const r = rig("brickedPartialFlash");
    const session = await r.open();
    const readings = await session.readAll();
    expect(readings.optr).toBe(0xfbeff800);
    expect(readings.flashHead).toBeUndefined();

    await expectSessionError(session.erase(testImage(), "pages"), "flash");
    await session.removeReadProtection({ clearSwBoot0: false });
    expect(r.sim.chip.optr).toBe(0xfbeff8aa);

    const image = testImage();
    await session.erase(image, "mass");
    expect(r.sim.chip.counters.massErases).toBe(1);
    await session.program(image);
    expect(await session.verify(image)).toBeUndefined();
    await session.resetAndRun();
    await session.close();
    expect(r.sim.chip.level2Written).toBe(false);
  });

  it("migratedBetaflight: reads the image and config, reflashes by page and keeps the config", async () => {
    const r = rig("migratedBetaflight");
    const session = await r.open();
    const readings = await session.readAll();
    expect(readings.optr).toBe(0xfbeff8aa);
    expect(readings.configMagic).toBe(0xbe);
    expect(readings.flashHead).toEqual(plausibleBetaflightImage()[0]!.bytes.subarray(0, 1024));

    // Already at Level 0: nothing to do, and no option-byte write.
    await session.removeReadProtection({ clearSwBoot0: false });
    expect(r.sim.chip.counters.optionBytePrograms).toBe(0);

    const image = testImage();
    await writeImage(session, image);
    expectImageInFlash(r.sim, image);
    expect((await session.readAll()).configMagic).toBe(0xbe);
    await session.resetAndRun();
    await session.close();
  });

  it("blankAfterErase: writes straight away", async () => {
    const r = rig("blankAfterErase");
    const session = await r.open();
    const readings = await session.readAll();
    expect(readings.optr).toBe(0xfbeff8aa);
    expect(allErased(readings.flashHead)).toBe(true);
    const image = testImage();
    await session.program(image);
    expect(await session.verify(image)).toBeUndefined();
    await session.resetAndRun();
    await session.close();
  });

  it("oldAlphaSwBoot: clears nSWBOOT0 in the same write as the unlock", async () => {
    const r = rig("oldAlphaSwBoot");
    const session = await r.open();
    expect((await session.readAll()).optr).toBe(0xffeff800);
    await expectSessionError(session.clearSwBoot0(), "flash");

    await session.removeReadProtection({ clearSwBoot0: true });
    expect(r.sim.chip.optr).toBe(0xfbeff8aa);
    expect(optrWrites(r.sim)).toEqual([0xfbeff8aa]);
    await writeImage(session, testImage());
    await session.close();
  });

  it("clearSwBoot0 alone at Level 0 changes only that bit", async () => {
    const r = rig("blankAfterErase", { chip: { optr: 0xffeff8aa } });
    const session = await r.open();
    await session.clearSwBoot0();
    expect(r.sim.chip.optr).toBe(0xfbeff8aa);
    await session.clearSwBoot0();
    expect(r.sim.chip.counters.optionBytePrograms).toBe(1);
    await session.close();
  });

  it("level2: entering SWD succeeds but the debug port never answers, in either mode", async () => {
    const r = rig("level2");
    await expectSessionError(r.open(), "no-target");
    r.sim.chip.pressReset();
    await expectSessionError(r.open({ mode: "holdReset", onAttached: () => r.sim.chip.releaseReset() }), "no-target");
    expect(r.sim.probe.opened).toBe(false);
  });

  it("wrongChip: reads work, every change is refused", async () => {
    const r = rig("wrongChip");
    const session = await r.open();
    expect((await session.readAll()).devId).toBe(0x413);
    await expectSessionError(session.removeReadProtection({ clearSwBoot0: true }), "wrong-chip");
    await expectSessionError(session.clearSwBoot0(), "wrong-chip");
    await expectSessionError(session.erase(testImage(), "mass"), "wrong-chip");
    await expectSessionError(session.program(testImage()), "wrong-chip");
    expect(r.sim.chip.counters.optionBytePrograms + r.sim.chip.counters.massErases + r.sim.chip.counters.doubleWords).toBe(0);
    await session.close();
  });

  it("wiringFault: no-target in either mode", async () => {
    const r = rig("wiringFault");
    await expectSessionError(r.open(), "no-target");
    r.sim.chip.pressReset();
    const error = await expectSessionError(r.open({ mode: "holdReset" }), "no-target");
    expect(error.message).toContain("JTAG_GET_IDCODE_ERROR");
  });
});

describe("hold-reset connect", () => {
  it("times out when the button is never released", async () => {
    const r = rig("stockAlpha073");
    r.sim.chip.pressReset();
    let attached = 0;
    await expectSessionError(r.open({ mode: "holdReset", onAttached: () => attached++ }), "timeout");
    expect(attached).toBe(1);
    expect(r.time.now()).toBeGreaterThanOrEqual(30_000);
  });

  it("fails as no-target when the button is released before the halt is armed", async () => {
    const r = rig("stockAlpha073");
    r.sim.chip.pressReset();
    r.sim.chip.releaseReset();
    await expectSessionError(r.open({ mode: "holdReset" }), "no-target");
  });

  it("halts a reachable running core even without the button", async () => {
    const r = rig("migratedBetaflight");
    const session = await r.open({ mode: "holdReset" });
    expect(r.sim.chip.coreState).toBe("halted");
    await session.close();
  });
});

describe("protection and failures", () => {
  it("leaves UID and flash size undefined when Level 1 hides them", async () => {
    const r = rig("brickedPartialFlash", { chip: { systemMemoryReadableAtLevel1: false } });
    const session = await r.open();
    const readings = await session.readAll();
    expect(readings.uid).toBeUndefined();
    expect(readings.flashSizeKb).toBeUndefined();
    expect(readings.devId).toBe(0x469);
    await session.close();
  });

  it("maps a BSY that never clears to timeout, for each kind of operation", async () => {
    const erase = rig("blankAfterErase", { faults: { busyStuck: "erase" } });
    await expectSessionError((await erase.open()).erase(testImage(), "pages"), "timeout");

    const program = rig("blankAfterErase", { faults: { busyStuck: "program" } });
    await expectSessionError((await program.open()).program(testImage()), "timeout");

    const unlock = rig("brickedPartialFlash", { faults: { busyStuck: "option-bytes" } });
    await expectSessionError((await unlock.open()).removeReadProtection({ clearSwBoot0: false }), "timeout");
  });

  it("returns the first differing address from verify", async () => {
    const r = rig("blankAfterErase", { faults: { verifyMismatchAt: 0x08006123 } });
    const session = await r.open();
    const image = testImage();
    await session.program(image);
    expect(await session.verify(image)).toBe(0x08006123);
    await session.close();
  });

  it("maps a flash error flag to flash: programming over data that was not erased", async () => {
    const r = rig("migratedBetaflight");
    const session = await r.open();
    const error = await expectSessionError(session.program(testImage()), "flash");
    expect(error.message).toContain("PROGERR");
    await session.close();
  });

  it("maps a probe pulled mid-write to usb", async () => {
    const r = rig("blankAfterErase", { faults: { usbLostAfterFrames: 60 } });
    const session = await r.open();
    await expectSessionError(session.program(testImage()), "usb");
    await session.close();
  });

  it("refuses to work after close", async () => {
    const r = rig("blankAfterErase");
    const session = await r.open();
    await session.close();
    await expectSessionError(session.readAll(), "usb");
  });

  it("keeps every memory transfer within 1 KB and inside one 1 KB block", async () => {
    const r = rig("migratedBetaflight");
    const session = await r.open();
    const image = plausibleBetaflightImage().map((block) => ({ address: block.address + 2, bytes: block.bytes.subarray(0, 5000) }));
    expect(await session.verify(image)).toBe(0x08000002);
    const unaligned = [{ address: 0x08006002, bytes: r.sim.chip.readFlash(0x08006002, 5000) }];
    expect(await session.verify(unaligned)).toBeUndefined();
    await session.close();
    for (const frame of r.sim.probe.frames.filter((f) => f[0] === 0xf2 && (f[1] === 0x07 || f[1] === 0x08))) {
      const view = new DataView(frame.buffer, frame.byteOffset);
      const address = view.getUint32(2, true);
      const length = view.getUint16(6, true);
      expect(length).toBeLessThanOrEqual(1024);
      expect(Math.floor(address / 1024)).toBe(Math.floor((address + length - 1) / 1024));
    }
  });

  it("never drives the probe's RST pin or writes RDP 0xCC across every scenario", async () => {
    for (const name of ["stockAlpha073", "brickedPartialFlash", "oldAlphaSwBoot"] as const) {
      const r = rig(name);
      const session = name === "stockAlpha073" ? (await openHoldingReset(r)).session : await r.open();
      await session.removeReadProtection({ clearSwBoot0: true });
      await session.close();
      expect(optrWrites(r.sim).every((value) => (value & 0xff) !== 0xcc)).toBe(true);
      expect(r.sim.chip.level2Written).toBe(false);
      expect(r.sim.probe.nrstDriven).toBe(false);
    }
  });
});

const FLASH_CR = 0x40022014;
const LOCKS = 0xc0000000;
const DBGMCU_APB1FZR1 = 0xe0042008;
const WATCHDOG_FREEZE = (1 << 11) | (1 << 12);

/** Index of the first WRITEDEBUGREG frame to `address`, or -1. */
function firstWriteTo(sim: AlphaSimulation, address: number): number {
  return sim.probe.frames.findIndex((frame) => frame[0] === 0xf2 && frame[1] === 0x35 && new DataView(frame.buffer, frame.byteOffset).getUint32(2, true) === address);
}

describe("review fixes", () => {
  it("exports the USB filters from the probe models", () => {
    expect(STLINK_USB_FILTERS).toEqual([
      { vendorId: 0x0483, productId: 0x3748 },
      { vendorId: 0x0483, productId: 0x374b },
      { vendorId: 0x0483, productId: 0x3752 },
    ]);
  });

  it("makes a transfer timeout fatal: the device is closed and later calls fail at once", async () => {
    const r = rig("blankAfterErase", { faults: { stallAfterFrames: 8 } });
    const session = await r.open({ transferTimeoutMs: 50 });
    await expectSessionError(session.readAll(), "timeout");
    expect(r.sim.probe.opened).toBe(false);

    const sent = r.sim.probe.frames.length;
    await expectSessionError(session.readAll(), "timeout");
    await expectSessionError(session.program(testImage()), "timeout");
    expect(r.sim.probe.frames.length).toBe(sent);
    await session.close();
  });

  it("makes a lost probe fatal too", async () => {
    const r = rig("blankAfterErase", { faults: { usbLostAfterFrames: 60 } });
    const session = await r.open();
    await expectSessionError(session.program(testImage()), "usb");
    await expectSessionError(session.readAll(), "usb");
    await session.close();
  });

  it("refuses to change a 256 KB G47x, read fresh rather than from readAll", async () => {
    const r = rig("migratedBetaflight", { chip: { flashSizeKb: 256 } });
    const session = await r.open();
    await expectSessionError(session.erase(testImage(), "pages"), "wrong-chip");
    await expectSessionError(session.erase(testImage(), "mass"), "wrong-chip");
    await expectSessionError(session.program(testImage()), "wrong-chip");
    await expectSessionError(session.clearSwBoot0(), "wrong-chip");
    expect(r.sim.chip.counters.pageErases + r.sim.chip.counters.massErases + r.sim.chip.counters.doubleWords).toBe(0);
    await session.close();
  });

  it("refuses when the flash size cannot be read, or the flash is single-bank", async () => {
    const hidden = rig("brickedPartialFlash", { chip: { systemMemoryReadableAtLevel1: false } });
    const locked = await hidden.open();
    const error = await expectSessionError(locked.removeReadProtection({ clearSwBoot0: false }), "wrong-chip");
    expect(error.message).toContain("unreadable");
    expect(hidden.sim.chip.counters.optionBytePrograms).toBe(0);
    await locked.close();

    const single = rig("blankAfterErase", { chip: { optr: 0xffaff8aa } });
    const session = await single.open();
    await expectSessionError(session.erase(testImage(), "mass"), "wrong-chip");
    await expectSessionError(session.program(testImage()), "wrong-chip");
    await session.close();
  });

  it("freezes the watchdogs before touching flash, after a hot-plug connect", async () => {
    const r = rig("blankAfterErase");
    const session = await r.open();
    await session.program(testImage());
    const freeze = firstWriteTo(r.sim, DBGMCU_APB1FZR1);
    expect(freeze).toBeGreaterThanOrEqual(0);
    expect(freeze).toBeLessThan(firstWriteTo(r.sim, 0x40022008));
    expect(r.sim.chip.read32(DBGMCU_APB1FZR1)! & WATCHDOG_FREEZE).toBe(WATCHDOG_FREEZE);
    await session.close();
  });

  it("freezes the watchdogs before touching flash, after a hold-reset connect", async () => {
    const r = rig("stockAlpha073");
    const { session } = await openHoldingReset(r);
    await session.removeReadProtection({ clearSwBoot0: false });
    const freeze = firstWriteTo(r.sim, DBGMCU_APB1FZR1);
    expect(freeze).toBeGreaterThanOrEqual(0);
    expect(freeze).toBeLessThan(firstWriteTo(r.sim, 0x40022008));
    expect(r.sim.chip.read32(DBGMCU_APB1FZR1)! & WATCHDOG_FREEZE).toBe(WATCHDOG_FREEZE);
    await session.close();
  });

  it("arms the reset-vector halt before OBL_LAUNCH, so firmware that takes SWCLK on boot cannot block the re-attach", async () => {
    const chip = { optr: 0xffeff8aa, firmwareClaimsSwclk: true, swclkClaimedAtStart: false };
    const r = rig("migratedBetaflight", { chip });
    const session = await r.open();
    await session.clearSwBoot0();
    expect(r.sim.chip.optr).toBe(0xfbeff8aa);
    expect(r.sim.chip.coreState).toBe("halted");
    expect((await session.readAll()).configMagic).toBe(0xbe);
    await session.close();

    // Control: once that firmware runs, it does take SWCLK and hot-plug fails.
    expect(r.sim.chip.debugPortState()).toBe("swclk-claimed");
    await expectSessionError(r.open(), "no-target");
  });

  it("relocks FLASH_CR and the option bytes when option-byte programming reports OPTVERR", async () => {
    const r = rig("brickedPartialFlash", { faults: { optionByteError: true } });
    const session = await r.open();
    const error = await expectSessionError(session.removeReadProtection({ clearSwBoot0: false }), "flash");
    expect(error.message).toContain("OPTVERR");
    expect((r.sim.chip.read32(FLASH_CR)! & LOCKS) >>> 0).toBe(LOCKS);
    expect(r.sim.chip.optr).toBe(0xfbeff800);
    expect(r.sim.chip.counters.oblLaunches).toBe(0);
    await session.close();
  });

  it("relocks FLASH_CR and the option bytes when option-byte programming times out", async () => {
    const r = rig("brickedPartialFlash", { faults: { busyStuck: "option-bytes" } });
    const session = await r.open();
    await expectSessionError(session.removeReadProtection({ clearSwBoot0: false }), "timeout");
    expect((r.sim.chip.read32(FLASH_CR)! & LOCKS) >>> 0).toBe(LOCKS);
    expect(r.sim.chip.counters.oblLaunches).toBe(0);
    await session.close();
  });
});
