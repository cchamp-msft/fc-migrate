/**
 * Probe-independent access to a target's memory map over SWD. The STM32G4 flash and
 * option-byte code is written against this, so a second probe type only needs to
 * implement it.
 */
export interface MemoryAccess {
  /** Reads one aligned 32-bit word. */
  read32(address: number): Promise<number>;
  /** Writes one aligned 32-bit word. */
  write32(address: number, value: number): Promise<void>;
  /** Reads `length` bytes with 32-bit accesses. Address and length must be multiples of 4. */
  readBlock(address: number, length: number): Promise<Uint8Array>;
  /** Writes bytes with 32-bit accesses, in increasing address order. Address and length must be multiples of 4. */
  writeBlock(address: number, data: Uint8Array): Promise<void>;
}

/**
 * `fault`: the debug port answered but the bus access failed (a protected or unmapped
 * address, or a peripheral that refused it).
 * `no-target`: the debug port itself stopped answering (wiring, a reset, a claimed pin).
 */
export type MemoryAccessFailure = "fault" | "no-target";

/** A target-side failure of one memory access. Host-side failures (USB) are reported by the probe. */
export class MemoryAccessError extends Error {
  constructor(
    readonly failure: MemoryAccessFailure,
    readonly address: number,
    message: string,
  ) {
    super(message);
    this.name = "MemoryAccessError";
  }
}

/** Formats an address or register value as 0x-prefixed, 8-digit hex. */
export function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}
