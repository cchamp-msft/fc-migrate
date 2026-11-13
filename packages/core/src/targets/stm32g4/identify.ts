/**
 * Read-only identification of an STM32G4 over SWD: DEV_ID, flash size, unique ID,
 * option bytes, protection registers and, when RDP allows, the start of flash.
 */
import { MemoryAccessError, type MemoryAccess } from "../../swd/memory-access.js";
import {
  CONFIG_AREA,
  DBGMCU_IDCODE,
  DEV_ID_MASK,
  FLASHSIZE_BASE,
  FLASH_HEAD_LENGTH,
  FLASH_REG,
  FLASH_START,
  OPTR,
  RDP_LEVEL_0,
  UID_BASE,
} from "./registers.js";
import type { G4Readings } from "./session.js";

/** Runs a read that may fault (an address the chip blocks); a fault gives undefined. A lost target still throws. */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MemoryAccessError && error.failure === "fault") return undefined;
    throw error;
  }
}

/** DBGMCU_IDCODE & 0xFFF. */
export async function readDevId(memory: MemoryAccess): Promise<number> {
  return (await memory.read32(DBGMCU_IDCODE)) & DEV_ID_MASK;
}

/** The 12 UID bytes in memory order as 24 hex digits: the same string Betaflight's MSP_UID gives. */
export function formatUid(bytes: Uint8Array): string {
  return [...bytes.subarray(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Flash size in KB, or undefined when unreadable or unprogrammed (0xFFFF). */
export async function readFlashSizeKb(memory: MemoryAccess): Promise<number | undefined> {
  const word = await optional(() => memory.read32(FLASHSIZE_BASE));
  if (word === undefined) return undefined;
  const kb = word & 0xffff;
  return kb === 0xffff || kb === 0 ? undefined : kb;
}

export async function readUid(memory: MemoryAccess): Promise<string | undefined> {
  const bytes = await optional(() => memory.readBlock(UID_BASE, 12));
  return bytes ? formatUid(bytes) : undefined;
}

/**
 * Reads everything the procedure classifies a board from. Flash contents are read only
 * at RDP Level 0; at Level 1 they stay undefined rather than failing.
 */
export async function readG4(memory: MemoryAccess): Promise<G4Readings> {
  const devId = await readDevId(memory);
  const flashSizeKb = await readFlashSizeKb(memory);
  const uid = await readUid(memory);
  const optr = (await memory.read32(FLASH_REG.OPTR)) >>> 0;
  const register = async (address: number): Promise<number> => (await memory.read32(address)) >>> 0;

  const readings: G4Readings = {
    devId,
    optr,
    wrp1ar: await register(FLASH_REG.WRP1AR),
    wrp1br: await register(FLASH_REG.WRP1BR),
    wrp2ar: await register(FLASH_REG.WRP2AR),
    wrp2br: await register(FLASH_REG.WRP2BR),
    pcrop1sr: await register(FLASH_REG.PCROP1SR),
    pcrop1er: await register(FLASH_REG.PCROP1ER),
    pcrop2sr: await register(FLASH_REG.PCROP2SR),
    pcrop2er: await register(FLASH_REG.PCROP2ER),
    sec1r: await register(FLASH_REG.SEC1R),
    sec2r: await register(FLASH_REG.SEC2R),
  };
  if (flashSizeKb !== undefined) readings.flashSizeKb = flashSizeKb;
  if (uid !== undefined) readings.uid = uid;

  if ((optr & OPTR.RDP_MASK) === RDP_LEVEL_0) {
    const head = await optional(() => memory.readBlock(FLASH_START, FLASH_HEAD_LENGTH));
    if (head) readings.flashHead = head;
    const magic = await optional(() => memory.read32(CONFIG_AREA));
    if (magic !== undefined) readings.configMagic = magic & 0xff;
  }
  return readings;
}
