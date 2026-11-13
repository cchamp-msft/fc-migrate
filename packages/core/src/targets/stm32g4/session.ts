/**
 * The contract between the Alpha Migrate procedure and the hardware layers below it.
 * The procedure, the web app and the demo use only these types; the ST-Link probe,
 * the SWD access and the simulator implement them.
 */
import type { HexBlock } from "../../firmware/hex.js";

/** Progress through a long step, in bytes. */
export type ByteProgress = (done: number, total: number) => void;

/** A USB device with bulk endpoints, as WebUSB and node-usb's WebUSB class provide. */
export interface UsbBulkDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status?: string; bytesWritten?: number }>;
  transferIn(endpointNumber: number, length: number): Promise<{ status?: string; data?: DataView }>;
}

export interface ProbeInfo {
  /** For example "ST-Link/V2" or "ST-Link/V2-1". */
  model: string;
  /** For example "V2J39S7". */
  firmware: string;
  /** Target voltage the probe measures, informational only. Undefined when it cannot tell. */
  targetVolts?: number;
}

/**
 * How to reach the chip.
 * `hotplug`: attach to a running chip without resetting it.
 * `holdReset`: the user is holding the board's reset button. Attach, arm a halt on
 * the reset vector, and return once the core is halted after the button is released.
 */
export type ConnectMode = "hotplug" | "holdReset";

/** Raw values read from the chip. The procedure classifies the board from these. */
export interface G4Readings {
  /** DBGMCU_IDCODE & 0xFFF. 0x469 for STM32G47x/G48x. */
  devId: number;
  /** Flash size in KB, from 0x1FFF75E0. Undefined when it could not be read. */
  flashSizeKb?: number;
  /** 96-bit unique ID as 24 hex digits, from 0x1FFF7590. Undefined when it could not be read. */
  uid?: string;
  /** FLASH_OPTR. RDP is bits 7:0, nSWBOOT0 bit 26, nBOOT0 bit 27, DBANK bit 22. */
  optr: number;
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
  /** First 1 KB of flash from 0x08000000. Undefined while read protection blocks it. */
  flashHead?: Uint8Array;
  /** First byte of the Betaflight config area at 0x08004000 (0xBE when a config is stored). */
  configMagic?: number;
}

/** One open SWD session on an STM32G4 behind a probe. Every method may throw a SessionError. */
export interface G4Session {
  readonly probe: ProbeInfo;
  /** Reads identity, option bytes, protection registers and, when readable, the start of flash. */
  readAll(): Promise<G4Readings>;
  /**
   * THE ONE-WAY STEP. Sets RDP to Level 0 (0xAA), which makes the chip mass-erase
   * all flash, then relaunches the option bytes and reconnects. Optionally clears
   * nSWBOOT0 in the same write. Never produces Level 2 (0xCC).
   */
  removeReadProtection(options: { clearSwBoot0: boolean }): Promise<void>;
  /** Clears nSWBOOT0 alone, at Level 0. Reversible. */
  clearSwBoot0(): Promise<void>;
  /** Erases only the pages the blocks touch (keeps the config area unless a block covers it), or the whole flash. */
  erase(blocks: readonly HexBlock[], mode: "pages" | "mass", onProgress?: ByteProgress): Promise<void>;
  program(blocks: readonly HexBlock[], onProgress?: ByteProgress): Promise<void>;
  /** Reads back every block. Resolves with the first differing address, or undefined when all match. */
  verify(blocks: readonly HexBlock[], onProgress?: ByteProgress): Promise<number | undefined>;
  /** Resets the chip and lets it run. The session stays usable for reads afterwards. */
  resetAndRun(): Promise<void>;
  close(): Promise<void>;
}

export type SessionErrorKind =
  /** The probe answered but the chip did not (wiring, no power, a claimed SWD pin, or Level 2). */
  | "no-target"
  /** The chip is not an STM32G4, or not one this procedure knows. */
  | "wrong-chip"
  /** The probe's firmware lacks a command the session needs. */
  | "probe-firmware"
  /** The USB device went away or a transfer failed. */
  | "usb"
  /** The flash controller stayed busy, or a transfer did not complete, in time. */
  | "timeout"
  /** The flash controller reported an error flag, or a write did not take. */
  | "flash";

export class SessionError extends Error {
  constructor(
    readonly kind: SessionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface OpenOptions {
  mode: ConnectMode;
  clockKhz?: number;
  /**
   * `holdReset` only: called once SWD is attached and the halt on reset is armed, while
   * the chip is still held in reset. The app then tells the pilot to release the button.
   */
  onAttached?: () => void;
}

/** Opens a session on a probe the user already chose. Implemented by the ST-Link layer. */
export type OpenG4Session = (device: UsbBulkDeviceLike, options: OpenOptions) => Promise<G4Session>;
