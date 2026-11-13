/**
 * Preset boards for Alpha Migrate's demo mode and tests (design 6.8). Each preset
 * builds fresh SimulatedG4 options; {@link createAlphaSimulation} wires a chip and a
 * simulated ST-Link together.
 *
 * Driving the reset button from a UI, for presets with `needsHoldReset`:
 *   1. `sim.chip.pressReset()` when the user says they are holding the button;
 *   2. `openStlinkG4Session(sim.probe, { mode: "holdReset", onAttached })`;
 *   3. in `onAttached` (or when the user clicks "Released"), `sim.chip.releaseReset()`.
 * The open promise then resolves with the core halted on its reset vector. For an
 * unattended demo, `pressReset({ autoReleaseMs: 1500 })` releases the button on its own
 * that long after the debugger arms the halt.
 */
import type { HexBlock } from "../firmware/hex.js";
import type { TimeSource } from "../swd/time.js";
import { RDP_LEVEL_2 } from "../targets/stm32g4/registers.js";
import { SimulatedG4, type SimulatedG4Faults, type SimulatedG4Options } from "./simulated-g4.js";
import { SimulatedStlink, type SimulatedStlinkOptions } from "./simulated-stlink.js";

export type AlphaScenarioName =
  | "stockAlpha073"
  | "brickedPartialFlash"
  | "migratedBetaflight"
  | "blankAfterErase"
  | "oldAlphaSwBoot"
  | "level2"
  | "wrongChip"
  | "wiringFault";

export interface AlphaScenario {
  name: AlphaScenarioName;
  title: string;
  description: string;
  /** Hot-plug connect fails; the user has to hold the reset button. */
  needsHoldReset: boolean;
  /** Fresh options for the chip, including its flash contents. */
  chip(): SimulatedG4Options;
}

/** Deterministic filler, so the same scenario always holds the same bytes. */
function pseudoRandom(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function uidFor(serial: number): string {
  const text = `SIMULATED${serial.toString().padStart(3, "0")}`;
  return [...text].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function putLe32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

/** Alpha 0.7.73's layout: FETtec's bootloader below 0x08003800, the application from there. Contents are filler. */
function alphaFlash(seed: number): HexBlock[] {
  return [
    { address: 0x08000000, bytes: pseudoRandom(0x3800, seed) },
    { address: 0x08003800, bytes: pseudoRandom(0x30000, seed + 1) },
  ];
}

/**
 * A plausible Betaflight G474 image: a vector table (SP at the top of SRAM, odd reset
 * vector in flash), code filler up to 0x080027FF, and the main image from 0x08006000
 * with the "Betaflight" and "BTFL" strings detection looks for. Not real firmware.
 */
export function plausibleBetaflightImage(): HexBlock[] {
  const head = pseudoRandom(0x2800, 0xbf01);
  putLe32(head, 0, 0x20020000);
  for (let vector = 1; vector < 118; vector++) putLe32(head, vector * 4, 0x08000201 + vector * 0x10);
  const main = pseudoRandom(0x40000, 0xbf02);
  const text = new TextEncoder().encode("Betaflight\0BTFL\0STM32G474\0TMOTORG4ALPHAHD\0");
  main.set(text, 0x200);
  return [
    { address: 0x08000000, bytes: head },
    { address: 0x08006000, bytes: main },
  ];
}

/** Betaflight's config area with a stored config: magic 0xBE, then filler. */
function storedConfig(): HexBlock {
  const bytes = pseudoRandom(0x800, 0xbe);
  bytes[0] = 0xbe;
  return { address: 0x08004000, bytes };
}

export const ALPHA_SCENARIOS: Readonly<Record<AlphaScenarioName, AlphaScenario>> = {
  stockAlpha073: {
    name: "stockAlpha073",
    title: "Stock Alpha 0.7.73",
    description: "Read protection Level 1 and nSWBOOT0 = 0, as Alpha 0.7.63 and later set on every boot. Alpha drives SWCLK, so hot-plug fails and the reset button must be held.",
    needsHoldReset: true,
    chip: () => ({ optr: 0xfbeff801, flash: alphaFlash(0x0773), firmwareClaimsSwclk: true, uid: uidFor(73) }),
  },
  brickedPartialFlash: {
    name: "brickedPartialFlash",
    title: "Bricked by a failed flash",
    description: "FLASH_OPTR 0xFBEFF800 as read on the bad board: Level 1, nSWBOOT0 = 0. Nothing runs, so hot-plug works.",
    needsHoldReset: false,
    chip: () => ({ optr: 0xfbeff800, flash: [{ address: 0x08000000, bytes: pseudoRandom(0x9000, 0xbad) }], uid: uidFor(800) }),
  },
  migratedBetaflight: {
    name: "migratedBetaflight",
    title: "Already on Betaflight",
    description: "Level 0 (0xFBEFF8AA) with a Betaflight image and a stored config (0xBE at 0x08004000).",
    needsHoldReset: false,
    chip: () => ({ optr: 0xfbeff8aa, flash: [...plausibleBetaflightImage(), storedConfig()], uid: uidFor(474) }),
  },
  blankAfterErase: {
    name: "blankAfterErase",
    title: "Erased, not yet written",
    description: "Level 0 and all flash 0xFF: a migration interrupted after the unlock.",
    needsHoldReset: false,
    chip: () => ({ optr: 0xfbeff8aa, uid: uidFor(255) }),
  },
  oldAlphaSwBoot: {
    name: "oldAlphaSwBoot",
    title: "Older Alpha, BOOT0 pin honoured",
    description: "FLASH_OPTR 0xFFEFF800: Level 1 with nSWBOOT0 = 1. Modelled as reachable by hot-plug.",
    needsHoldReset: false,
    chip: () => ({ optr: 0xffeff800, flash: alphaFlash(0x0742), uid: uidFor(742) }),
  },
  level2: {
    name: "level2",
    title: "Read protection Level 2",
    description: "RDP 0xCC: the debug port is disabled for good. Entering SWD succeeds, every DP access fails.",
    needsHoldReset: false,
    chip: () => ({ optr: (0xfbeff800 | RDP_LEVEL_2) >>> 0, flash: alphaFlash(0x0c), uid: uidFor(2) }),
  },
  wrongChip: {
    name: "wrongChip",
    title: "Not a G4 (STM32F405)",
    description: "The chip answers with DEV_ID 0x413. Reads work; every change is refused.",
    needsHoldReset: false,
    chip: () => ({ devId: 0x413, optr: 0xffeff8aa, uid: uidFor(405) }),
  },
  wiringFault: {
    name: "wiringFault",
    title: "Wiring fault",
    description: "The debug port never answers: a missing wire, no power, or swapped SWDIO and SWCLK.",
    needsHoldReset: false,
    chip: () => ({ wiring: "unwired" }),
  },
};

export interface AlphaSimulationOptions {
  /** Shared by the chip and the probe. Pass a VirtualTime in tests; the default is wall-clock time. */
  time?: TimeSource;
  /** Overrides for the chip, applied over the preset. */
  chip?: Partial<SimulatedG4Options>;
  /** Options for the simulated ST-Link (latency, model, recording). */
  probe?: Omit<SimulatedStlinkOptions, "time" | "usbLostAfterFrames" | "stallAfterFrames">;
  /** Fault injection: USB lost or replies stalled after N command blocks, BSY stuck, OPTVERR, verify mismatch. */
  faults?: SimulatedG4Faults & { usbLostAfterFrames?: number; stallAfterFrames?: number };
}

export interface AlphaSimulation {
  scenario: AlphaScenario;
  chip: SimulatedG4;
  /** Pass this to openStlinkG4Session as the device. */
  probe: SimulatedStlink;
}

export function createAlphaSimulation(name: AlphaScenarioName, options: AlphaSimulationOptions = {}): AlphaSimulation {
  const scenario = ALPHA_SCENARIOS[name];
  const { usbLostAfterFrames, stallAfterFrames, ...chipFaults } = options.faults ?? {};
  const preset = scenario.chip();
  const chip = new SimulatedG4({
    ...preset,
    ...options.chip,
    faults: { ...preset.faults, ...options.chip?.faults, ...chipFaults },
    ...(options.time ? { time: options.time } : {}),
  });
  const probe = new SimulatedStlink(chip, {
    ...options.probe,
    ...(usbLostAfterFrames === undefined ? {} : { usbLostAfterFrames }),
    ...(stallAfterFrames === undefined ? {} : { stallAfterFrames }),
    ...(options.time ? { time: options.time } : {}),
  });
  return { scenario, chip, probe };
}
