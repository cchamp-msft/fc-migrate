/**
 * An STM32G474 as seen from a debug probe: memory map, FLASH controller, option bytes,
 * read protection, Cortex-M debug registers, NRST (the board's reset button) and the
 * SWCLK pin that Alpha firmware takes over. {@link SimulatedStlink} puts the ST-Link
 * protocol in front of it. Values are modelled on RM0440 and stm32g474xx.h; the
 * protection-register values are plausible "inactive" values, not captures.
 */
import type { HexBlock } from "../firmware/hex.js";
import { realTime, type TimeSource } from "../swd/time.js";
import {
  BANK2_START,
  BANK_SIZE,
  CR,
  DBGMCU_IDCODE,
  DEV_ID_G47X,
  FLASHSIZE_BASE,
  FLASH_KEY1,
  FLASH_KEY2,
  FLASH_REGS_BASE,
  FLASH_SIZE,
  FLASH_START,
  OPTR,
  OPT_KEY1,
  OPT_KEY2,
  PACKAGE_BASE,
  PAGE_SIZE,
  RDP_LEVEL_0,
  RDP_LEVEL_2,
  SR,
  SR_ERRORS,
  UID_BASE,
} from "../targets/stm32g4/registers.js";

/** Factory FLASH_OPTR: Level 0, dual bank, BOOT0 pin honoured. */
export const FACTORY_OPTR = 0xffeff8aa;

/** The DP IDCODE of a Cortex-M4 SW-DP. */
export const CORTEX_M4_DP_IDCODE = 0x2ba01477;

export interface SimulatedG4Faults {
  /** BSY never clears once this kind of flash operation starts. */
  busyStuck?: "erase" | "program" | "option-bytes" | "any";
  /** Programming the double word that holds this address stores that byte inverted, so verify fails there. */
  verifyMismatchAt?: number;
  /** Option-byte programming (OPTSTRT) fails with OPTVERR and changes nothing. */
  optionByteError?: boolean;
}

/** How long each flash operation keeps BSY set, in milliseconds. */
export interface SimulatedBusyTimes {
  program: number;
  pageErase: number;
  massErase: number;
  optionBytes: number;
}

export interface SimulatedProtection {
  wrp1ar: number;
  wrp1br: number;
  wrp2ar: number;
  wrp2br: number;
  pcrop1sr: number;
  pcrop1er: number;
  pcrop2sr: number;
  pcrop2er: number;
  sec1r: number;
  sec2r: number;
}

/** WRP and PCROP with start above end, no secure area, no BOOT_LOCK. */
export const INACTIVE_PROTECTION: SimulatedProtection = {
  wrp1ar: 0xff00ffff,
  wrp1br: 0xff00ffff,
  wrp2ar: 0xff00ffff,
  wrp2br: 0xff00ffff,
  pcrop1sr: 0xffffffff,
  pcrop1er: 0x7fff0000,
  pcrop2sr: 0xffffffff,
  pcrop2er: 0x7fff0000,
  sec1r: 0xff00ff00,
  sec2r: 0xff00ff00,
};

export interface SimulatedG4Options {
  /** FLASH_OPTR as programmed. Default {@link FACTORY_OPTR}. RDP 0xCC disables the debug port. */
  optr?: number;
  /** DBGMCU DEV_ID. Default 0x469. */
  devId?: number;
  /** DBGMCU REV_ID. Default 0x2001. */
  revId?: number;
  /** The flash-size word, in KB. Default 512. */
  flashSizeKb?: number;
  /** 24 hex digits, memory order. Default a synthetic "SIMULATED001". */
  uid?: string;
  /** Initial flash contents; everything else reads 0xFF. */
  flash?: readonly HexBlock[];
  /**
   * The firmware in flash takes PA14 (SWCLK) once it runs, as Alpha's receiver code
   * does, so SWD stops answering until the next reset. Any reset gives the pin back.
   */
  firmwareClaimsSwclk?: boolean;
  /**
   * Whether the running firmware already holds SWCLK when the simulation starts.
   * Default: same as `firmwareClaimsSwclk`. False models firmware that only takes the
   * pin when it next boots, so hot-plug works until then.
   */
  swclkClaimedAtStart?: boolean;
  /** "unwired": the debug port never answers. */
  wiring?: "ok" | "unwired";
  /** Whether the UID and flash-size words can be read at RDP Level 1. Default true (unconfirmed on hardware). */
  systemMemoryReadableAtLevel1?: boolean;
  protection?: Partial<SimulatedProtection>;
  busyMs?: Partial<SimulatedBusyTimes>;
  faults?: SimulatedG4Faults;
  time?: TimeSource;
}

/** What the probe sees when it drives SWD. */
export type DebugPortState = "ok" | "unwired" | "disabled" | "swclk-claimed";

export type CoreState = "running" | "halted" | "reset";

const DEFAULT_BUSY: SimulatedBusyTimes = { program: 0, pageErase: 20, massErase: 25, optionBytes: 40 };
const DEFAULT_UID = "53494d554c41544544303031"; // "SIMULATED001"

const DHCSR = 0xe000edf0;
const DCRSR = 0xe000edf4;
const DCRDR = 0xe000edf8;
const DEMCR = 0xe000edfc;
const AIRCR = 0xe000ed0c;
const CPUID = 0xe000ed00;
const CORTEX_M4_CPUID = 0x410fc241;
const DBGKEY = 0xa05f;
const C_DEBUGEN = 1 << 0;
const C_HALT = 1 << 1;
const S_REGRDY = 1 << 16;
const S_HALT = 1 << 17;
const S_RESET_ST = 1 << 25;
const VC_CORERESET = 1 << 0;

const SRAM_START = 0x20000000;
const SRAM_SIZE = 128 * 1024;
const SYSTEM_MEMORY_START = 0x1fff0000;
const SYSTEM_MEMORY_END = 0x1fff8000;
const DBGMCU_END = 0xe0042014;
const FLASH_REGS_END = FLASH_REGS_BASE + 0x400;
/** Errors that stop a new program or erase from starting until cleared. */
const BLOCKING_ERRORS = (SR.OPERR | SR.PROGERR | SR.WRPERR | SR.PGAERR | SR.SIZERR | SR.PGSERR | SR.MISERR | SR.FASTERR) >>> 0;
/** CR bits that are stored as written. LOCK, OPTLOCK, STRT, OPTSTRT and OBL_LAUNCH are handled separately. */
const CR_STORED = (CR.PG | CR.PER | CR.MER1 | CR.PNB_MASK | CR.BKER | CR.MER2 | CR.FSTPG | (1 << 24) | (1 << 25) | (1 << 26)) >>> 0;

type FlashOperation = "erase" | "program" | "option-bytes";

function uidBytes(uid: string): Uint8Array {
  if (!/^[0-9a-f]{24}$/i.test(uid)) throw new RangeError("uid must be 24 hex digits");
  return Uint8Array.from({ length: 12 }, (_, index) => Number.parseInt(uid.slice(index * 2, index * 2 + 2), 16));
}

function rdpLevel(optr: number): 0 | 1 | 2 {
  const rdp = optr & OPTR.RDP_MASK;
  return rdp === RDP_LEVEL_0 ? 0 : rdp === RDP_LEVEL_2 ? 2 : 1;
}

export class SimulatedG4 {
  readonly time: TimeSource;
  private readonly flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  private readonly sram = new Uint8Array(SRAM_SIZE);
  private readonly devId: number;
  private readonly revId: number;
  private readonly flashSizeKb: number;
  private readonly uid: Uint8Array;
  private readonly wiring: "ok" | "unwired";
  private readonly systemMemoryReadableAtLevel1: boolean;
  private readonly busyTimes: SimulatedBusyTimes;
  private readonly faults: SimulatedG4Faults;
  private readonly protection: SimulatedProtection;

  /** Option bytes as stored in flash. */
  private storedOptr: number;
  /** Option bytes in force since the last load (power-on or OBL_LAUNCH). */
  private loadedOptr: number;
  /** FLASH_OPTR register: the loaded value, or what was written since. */
  private optrRegister: number;

  private cr = (CR.LOCK | CR.OPTLOCK) >>> 0;
  private sr = 0;
  private keyStage = 0;
  private optKeyStage = 0;
  private crLockedUntilReset = false;
  private busyUntil = 0;
  private pendingWord: { address: number; value: number } | undefined;

  private core: CoreState = "running";
  private dhcsrControl = 0;
  private resetSticky = false;
  private demcr = 0;
  private readonly dbgmcu = new Map<number, number>();
  private firmwareClaimsSwclk: boolean;
  private swclkClaimed: boolean;
  private nrstHeld = false;
  private autoReleaseMs: number | undefined;
  private armedAt: number | undefined;
  private epoch = 0;

  /** Set if anything ever programmed RDP 0xCC. Tests assert it stays false. */
  level2Written = false;
  /** Counts of what happened, for assertions. */
  readonly counters = { pageErases: 0, massErases: 0, doubleWords: 0, optionBytePrograms: 0, oblLaunches: 0, systemResets: 0 };

  constructor(options: SimulatedG4Options = {}) {
    this.time = options.time ?? realTime;
    this.devId = options.devId ?? DEV_ID_G47X;
    this.revId = options.revId ?? 0x2001;
    this.flashSizeKb = options.flashSizeKb ?? 512;
    this.uid = uidBytes(options.uid ?? DEFAULT_UID);
    this.wiring = options.wiring ?? "ok";
    this.systemMemoryReadableAtLevel1 = options.systemMemoryReadableAtLevel1 ?? true;
    this.busyTimes = { ...DEFAULT_BUSY, ...options.busyMs };
    this.faults = { ...options.faults };
    this.protection = { ...INACTIVE_PROTECTION, ...options.protection };
    this.storedOptr = (options.optr ?? FACTORY_OPTR) >>> 0;
    this.loadedOptr = this.storedOptr;
    this.optrRegister = this.storedOptr;
    this.firmwareClaimsSwclk = options.firmwareClaimsSwclk ?? false;
    this.swclkClaimed = this.firmwareClaimsSwclk && (options.swclkClaimedAtStart ?? true);
    for (const block of options.flash ?? []) this.flash.set(block.bytes, block.address - FLASH_START);
  }

  // ---- Controls a demo UI or test drives -------------------------------------------

  /**
   * The user presses and holds the board's reset button: NRST goes low, the core is
   * held in reset and the firmware lets go of SWCLK. With `autoReleaseMs`, the button
   * is released that long after a debugger arms the halt on reset (DEMCR.VC_CORERESET
   * with debug enabled), as a user following the app's prompt would.
   */
  pressReset(options: { autoReleaseMs?: number } = {}): void {
    this.nrstHeld = true;
    this.core = "reset";
    this.swclkClaimed = false;
    this.resetSticky = true;
    this.pendingWord = undefined;
    this.autoReleaseMs = options.autoReleaseMs;
    this.armedAt = this.isResetCatchArmed() ? this.time.now() : undefined;
  }

  /** The user releases the reset button. The core halts on the reset vector if a debugger armed it, else the firmware runs. */
  releaseReset(): void {
    if (!this.nrstHeld) return;
    this.nrstHeld = false;
    this.autoReleaseMs = undefined;
    this.armedAt = undefined;
    this.systemResetEffects();
    this.leaveReset();
  }

  get resetHeld(): boolean {
    this.tick();
    return this.nrstHeld;
  }

  /** Unplug and replug: option bytes reload, debug state clears. */
  powerCycle(): void {
    this.loadedOptr = this.storedOptr;
    this.optrRegister = this.storedOptr;
    this.debugDomainReset();
    this.systemResetEffects();
    if (!this.nrstHeld) this.leaveReset();
  }

  // ---- Inspection for tests and the demo ---------------------------------------------

  get coreState(): CoreState {
    this.tick();
    return this.core;
  }

  /** FLASH_OPTR in force. */
  get optr(): number {
    return this.loadedOptr;
  }

  /** A copy of flash bytes, regardless of read protection. */
  readFlash(address: number, length: number): Uint8Array {
    return this.flash.slice(address - FLASH_START, address - FLASH_START + length);
  }

  // ---- What the probe uses -----------------------------------------------------------

  /** Increments whenever the debug port is reset or garbled, so a probe must re-enter SWD. */
  get dpEpoch(): number {
    this.tick();
    return this.epoch;
  }

  debugPortState(): DebugPortState {
    this.tick();
    if (this.wiring === "unwired") return "unwired";
    if (rdpLevel(this.loadedOptr) === 2) return "disabled";
    if (this.swclkClaimed) return "swclk-claimed";
    return "ok";
  }

  get halted(): boolean {
    this.tick();
    return this.core === "halted";
  }

  /** One 32-bit read through the AHB-AP. Undefined is a bus fault. */
  read32(address: number): number | undefined {
    this.tick();
    address >>>= 0;
    if (address % 4 !== 0) return undefined;
    if (this.nrstHeld && address < 0xe0000000) return undefined;

    if (address >= FLASH_START && address < FLASH_START + FLASH_SIZE) {
      if (rdpLevel(this.loadedOptr) !== 0) return undefined;
      return this.readLe(this.flash, address - FLASH_START);
    }
    if (address >= SRAM_START && address < SRAM_START + SRAM_SIZE) return this.readLe(this.sram, address - SRAM_START);
    if (address >= SYSTEM_MEMORY_START && address < SYSTEM_MEMORY_END) return this.readSystemMemory(address);
    if (address >= FLASH_REGS_BASE && address < FLASH_REGS_END) return this.readFlashRegister(address);
    if (address >= DBGMCU_IDCODE && address < DBGMCU_END) {
      if (address === DBGMCU_IDCODE) return ((this.revId << 16) | this.devId) >>> 0;
      return this.dbgmcu.get(address) ?? 0;
    }
    switch (address) {
      case CPUID:
        return CORTEX_M4_CPUID;
      case AIRCR:
        return 0xfa050000;
      case DHCSR: {
        const value = this.dhcsrControl | S_REGRDY | (this.core === "halted" ? S_HALT : 0) | (this.resetSticky ? S_RESET_ST : 0);
        if (this.core !== "reset") this.resetSticky = false;
        return value >>> 0;
      }
      case DEMCR:
        return this.demcr >>> 0;
      case DCRSR:
      case DCRDR:
        return 0;
    }
    return undefined;
  }

  /** One 32-bit write through the AHB-AP. False is a bus fault. */
  write32(address: number, value: number): boolean {
    this.tick();
    address >>>= 0;
    value >>>= 0;
    if (address % 4 !== 0) return false;
    if (this.nrstHeld && address < 0xe0000000) return false;

    if (address >= FLASH_START && address < FLASH_START + FLASH_SIZE) return this.writeFlash(address, value);
    if (address >= SRAM_START && address < SRAM_START + SRAM_SIZE) {
      this.writeLe(this.sram, address - SRAM_START, value);
      return true;
    }
    if (address >= FLASH_REGS_BASE && address < FLASH_REGS_END) return this.writeFlashRegister(address, value);
    if (address > DBGMCU_IDCODE && address < DBGMCU_END) {
      this.dbgmcu.set(address, value);
      return true;
    }
    switch (address) {
      case DHCSR:
        this.writeDhcsr(value);
        return true;
      case DEMCR:
        this.demcr = value;
        this.noteArming();
        return true;
      case AIRCR:
        if (value >>> 16 === 0x05fa && (value & (1 << 2)) !== 0) this.systemReset();
        return true;
      case DCRSR:
      case DCRDR:
        return true;
    }
    return false;
  }

  /** A system reset (AIRCR.SYSRESETREQ or the probe's RESETSYS). Debug registers survive it. */
  systemReset(): void {
    this.counters.systemResets++;
    this.systemResetEffects();
    if (this.nrstHeld) {
      this.core = "reset";
      return;
    }
    this.leaveReset();
  }

  // ---- Internals ---------------------------------------------------------------------

  /** Applies time-driven events: the automatic button release. */
  private tick(): void {
    if (this.nrstHeld && this.autoReleaseMs !== undefined && this.armedAt !== undefined && this.time.now() >= this.armedAt + this.autoReleaseMs) {
      this.releaseReset();
    }
  }

  private isResetCatchArmed(): boolean {
    return (this.dhcsrControl & C_DEBUGEN) !== 0 && (this.demcr & VC_CORERESET) !== 0;
  }

  private noteArming(): void {
    if (this.nrstHeld && this.armedAt === undefined && this.isResetCatchArmed()) this.armedAt = this.time.now();
  }

  private writeDhcsr(value: number): void {
    if (value >>> 16 !== DBGKEY) return;
    this.dhcsrControl = value & 0xf;
    const debug = (this.dhcsrControl & C_DEBUGEN) !== 0;
    const haltRequested = debug && (this.dhcsrControl & C_HALT) !== 0;
    if (this.core === "running" && haltRequested) this.core = "halted";
    else if (this.core === "halted" && !haltRequested) this.startRunning();
    this.noteArming();
  }

  private startRunning(): void {
    this.core = "running";
    // Firmware that takes SWCLK garbles the SWD link; the probe has to start over.
    if (this.firmwareClaimsSwclk && !this.swclkClaimed) {
      this.swclkClaimed = true;
      this.epoch++;
    }
  }

  /**
   * The core comes out of reset. Only DEMCR.VC_CORERESET (with debug enabled) halts it
   * on the reset vector; a halt request made before the reset is not relied on.
   */
  private leaveReset(): void {
    this.resetSticky = true;
    const debug = (this.dhcsrControl & C_DEBUGEN) !== 0;
    if (debug && (this.demcr & VC_CORERESET) !== 0) this.core = "halted";
    else this.startRunning();
  }

  /**
   * What every reset does: the flash controller relocks, GPIOs (SWCLK) are released,
   * and C_HALT is dropped. DEMCR, C_DEBUGEN and DBGMCU are in the debug domain and survive.
   */
  private systemResetEffects(): void {
    this.swclkClaimed = false;
    this.dhcsrControl &= ~C_HALT;
    this.cr = (CR.LOCK | CR.OPTLOCK) >>> 0;
    this.sr = 0;
    this.keyStage = 0;
    this.optKeyStage = 0;
    this.crLockedUntilReset = false;
    this.pendingWord = undefined;
    this.busyUntil = 0;
  }

  private debugDomainReset(): void {
    this.dhcsrControl = 0;
    this.demcr = 0;
    this.dbgmcu.clear();
    this.epoch++;
  }

  private busy(): boolean {
    return this.time.now() < this.busyUntil;
  }

  private startBusy(operation: FlashOperation, ms: number): void {
    const stuck = this.faults.busyStuck;
    if (stuck === "any" || stuck === operation) {
      this.busyUntil = Number.POSITIVE_INFINITY;
      return;
    }
    this.busyUntil = Math.max(this.busyUntil, this.time.now()) + ms;
  }

  private readLe(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
  }

  private writeLe(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  private readSystemMemory(address: number): number | undefined {
    if (rdpLevel(this.loadedOptr) !== 0 && !this.systemMemoryReadableAtLevel1) return undefined;
    if (address >= UID_BASE && address < UID_BASE + 12) return this.readLe(this.uid, address - UID_BASE);
    if (address === FLASHSIZE_BASE) return (0xffff0000 | this.flashSizeKb) >>> 0;
    if (address === PACKAGE_BASE) return 0xfffffff5;
    return 0xffffffff;
  }

  private readFlashRegister(address: number): number {
    switch (address - FLASH_REGS_BASE) {
      case 0x10:
        return (this.sr | (this.busy() ? SR.BSY : 0)) >>> 0;
      case 0x14:
        return this.cr >>> 0;
      case 0x20:
        return this.optrRegister >>> 0;
      case 0x24:
        return this.protection.pcrop1sr;
      case 0x28:
        return this.protection.pcrop1er;
      case 0x2c:
        return this.protection.wrp1ar;
      case 0x30:
        return this.protection.wrp1br;
      case 0x44:
        return this.protection.pcrop2sr;
      case 0x48:
        return this.protection.pcrop2er;
      case 0x4c:
        return this.protection.wrp2ar;
      case 0x50:
        return this.protection.wrp2br;
      case 0x70:
        return this.protection.sec1r;
      case 0x74:
        return this.protection.sec2r;
      default:
        return 0;
    }
  }

  /** A wrong key sequence locks FLASH_CR until the next reset and is a bus error (RM0440 3.3.5). */
  private keyFault(): false {
    this.crLockedUntilReset = true;
    this.keyStage = 0;
    this.optKeyStage = 0;
    return false;
  }

  private writeFlashRegister(address: number, value: number): boolean {
    switch (address - FLASH_REGS_BASE) {
      case 0x08: // KEYR
        if (this.crLockedUntilReset || (this.cr & CR.LOCK) === 0) return this.keyFault();
        if (this.keyStage === 0 && value === FLASH_KEY1) this.keyStage = 1;
        else if (this.keyStage === 1 && value === FLASH_KEY2) {
          this.keyStage = 0;
          this.cr = (this.cr & ~CR.LOCK) >>> 0;
        } else return this.keyFault();
        return true;
      case 0x0c: // OPTKEYR
        if (this.crLockedUntilReset || (this.cr & CR.LOCK) !== 0 || (this.cr & CR.OPTLOCK) === 0) return this.keyFault();
        if (this.optKeyStage === 0 && value === OPT_KEY1) this.optKeyStage = 1;
        else if (this.optKeyStage === 1 && value === OPT_KEY2) {
          this.optKeyStage = 0;
          this.cr = (this.cr & ~CR.OPTLOCK) >>> 0;
        } else return this.keyFault();
        return true;
      case 0x10: // SR: write 1 to clear
        this.sr = (this.sr & ~(value & (SR_ERRORS | SR.EOP))) >>> 0;
        return true;
      case 0x14:
        this.writeCr(value);
        return true;
      case 0x20: // OPTR
        if ((this.cr & CR.OPTLOCK) === 0) this.optrRegister = value >>> 0;
        return true;
      default:
        return true;
    }
  }

  private writeCr(value: number): void {
    if ((this.cr & CR.LOCK) !== 0) {
      // Locked: nothing changes. (LOCK and OPTLOCK are already set.)
      return;
    }
    if ((value & CR.LOCK) !== 0) {
      this.cr = (CR.LOCK | CR.OPTLOCK) >>> 0;
      this.pendingWord = undefined;
      return;
    }
    const optionsUnlocked = (this.cr & CR.OPTLOCK) === 0;
    this.cr = ((value & CR_STORED) | (this.cr & CR.OPTLOCK) | (value & CR.OPTLOCK)) >>> 0;
    if ((this.cr & CR.PG) === 0) this.pendingWord = undefined;

    if ((value & CR.STRT) !== 0) this.startErase();
    if ((value & CR.OPTSTRT) !== 0 && optionsUnlocked) this.programOptionBytes();
    if ((value & CR.OBL_LAUNCH) !== 0 && optionsUnlocked) this.launchOptionBytes();
  }

  private startErase(): void {
    if ((this.sr & BLOCKING_ERRORS) !== 0) {
      this.sr |= SR.PGSERR;
      return;
    }
    if (rdpLevel(this.loadedOptr) !== 0) {
      // Level 1 with a debugger attached: flash cannot be erased.
      this.sr |= SR.WRPERR;
      return;
    }
    const per = (this.cr & CR.PER) !== 0;
    const mer1 = (this.cr & CR.MER1) !== 0;
    const mer2 = (this.cr & CR.MER2) !== 0;
    const pg = (this.cr & CR.PG) !== 0;
    if (pg || (per && (mer1 || mer2)) || (!per && !mer1 && !mer2)) {
      this.sr |= SR.PGSERR;
      return;
    }
    if (per) {
      const index = (this.cr & CR.PNB_MASK) >>> CR.PNB_SHIFT;
      const dualBank = (this.loadedOptr & OPTR.DBANK) !== 0;
      const start = dualBank ? ((this.cr & CR.BKER) !== 0 ? BANK2_START : FLASH_START) + index * PAGE_SIZE : FLASH_START + index * PAGE_SIZE * 2;
      const length = dualBank ? PAGE_SIZE : PAGE_SIZE * 2;
      this.eraseRange(start, length);
      this.counters.pageErases++;
      this.startBusy("erase", this.busyTimes.pageErase);
      return;
    }
    if (mer1) this.eraseRange(FLASH_START, BANK_SIZE);
    if (mer2) this.eraseRange(BANK2_START, BANK_SIZE);
    this.counters.massErases++;
    this.startBusy("erase", this.busyTimes.massErase);
  }

  private eraseRange(start: number, length: number): void {
    this.flash.fill(0xff, start - FLASH_START, start - FLASH_START + length);
    // The firmware is gone once its vector table is.
    if (start === FLASH_START) this.firmwareClaimsSwclk = false;
  }

  private programOptionBytes(): void {
    this.counters.optionBytePrograms++;
    if (this.faults.optionByteError) {
      this.sr |= SR.OPTVERR;
      this.startBusy("option-bytes", this.busyTimes.optionBytes);
      return;
    }
    const next = this.optrRegister >>> 0;
    if ((next & OPTR.RDP_MASK) === RDP_LEVEL_2) this.level2Written = true;
    // RDP regression from Level 1 to Level 0 mass-erases main flash.
    if (rdpLevel(this.loadedOptr) === 1 && (next & OPTR.RDP_MASK) === RDP_LEVEL_0) {
      this.eraseRange(FLASH_START, FLASH_SIZE);
    }
    this.storedOptr = next;
    this.startBusy("option-bytes", this.busyTimes.optionBytes);
  }

  /**
   * OBL_LAUNCH: reload the option bytes and reset. RM0440 lists the option-byte loader
   * reset as a system reset, so debug registers survive, but the SWD link drops and the
   * probe has to re-enter.
   */
  private launchOptionBytes(): void {
    this.counters.oblLaunches++;
    this.loadedOptr = this.storedOptr;
    this.optrRegister = this.storedOptr;
    this.epoch++;
    this.systemResetEffects();
    if (this.nrstHeld) this.core = "reset";
    else this.leaveReset();
  }

  private writeFlash(address: number, value: number): boolean {
    // Level 1 with a debugger attached: flash is out of reach of the bus (AP fault).
    if (rdpLevel(this.loadedOptr) !== 0) return false;
    if ((this.cr & CR.PG) === 0 || (this.sr & BLOCKING_ERRORS) !== 0) {
      this.sr |= SR.PGSERR;
      this.pendingWord = undefined;
      return true;
    }
    const pending = this.pendingWord;
    if (!pending) {
      if (address % 8 !== 0) this.sr |= SR.PGAERR;
      else this.pendingWord = { address, value };
      return true;
    }
    this.pendingWord = undefined;
    if (address !== pending.address + 4) {
      this.sr |= SR.PGAERR;
      return true;
    }
    const offset = pending.address - FLASH_START;
    const erased = this.flash.subarray(offset, offset + 8).every((byte) => byte === 0xff);
    if (!erased && (pending.value !== 0 || value !== 0)) {
      this.sr |= SR.PROGERR;
      return true;
    }
    this.writeLe(this.flash, offset, pending.value);
    this.writeLe(this.flash, offset + 4, value);
    const mismatch = this.faults.verifyMismatchAt;
    if (mismatch !== undefined && mismatch >= pending.address && mismatch < pending.address + 8) {
      this.flash[mismatch - FLASH_START] = ~this.flash[mismatch - FLASH_START]! & 0xff;
    }
    this.counters.doubleWords++;
    this.startBusy("program", this.busyTimes.program);
    return true;
  }
}
