/**
 * STM32G4 flash-controller recipes over any MemoryAccess: unlock and lock, page and
 * mass erase, double-word programming with BSY polls, and read-back verification.
 * Sequences follow the HAL (stm32g4xx_hal_flash.c, stm32g4xx_hal_flash_ex.c) and
 * stlink-org's G4 support. Main flash must be at RDP Level 0 for any of this.
 */
import type { HexBlock } from "../../firmware/hex.js";
import { hex32, type MemoryAccess } from "../../swd/memory-access.js";
import { pollUntil, type TimeSource } from "../../swd/time.js";
import {
  BANK2_START,
  BANK_SIZE,
  CR,
  FLASH_END,
  FLASH_KEY1,
  FLASH_KEY2,
  FLASH_REG,
  FLASH_START,
  OPT_KEY1,
  OPT_KEY2,
  PAGE_SIZE,
  SR,
  SR_ERRORS,
  srErrorNames,
} from "./registers.js";
import { SessionError, type ByteProgress } from "./session.js";

/** How long each kind of operation may keep BSY set. All far above the datasheet maxima. */
export interface FlashTimeouts {
  pageEraseMs: number;
  massEraseMs: number;
  doubleWordMs: number;
  /** Option-byte programming, which includes the mass erase of an RDP regression. */
  optionBytesMs: number;
}

export const DEFAULT_FLASH_TIMEOUTS: FlashTimeouts = {
  pageEraseMs: 5_000,
  massEraseMs: 30_000,
  doubleWordMs: 1_000,
  optionBytesMs: 60_000,
};

/** Progress is reported at most this often, in bytes, plus once at the end. */
const PROGRESS_STEP = 1024;
/** Verify reads this much per MemoryAccess call. */
const VERIFY_CHUNK = 4096;

/** Waits for BSY to clear. Resolves with the final SR; throws SessionError "timeout". */
export async function waitFlashIdle(memory: MemoryAccess, time: TimeSource, timeoutMs: number, what: string): Promise<number> {
  const sr = await pollUntil(
    time,
    timeoutMs,
    () => memory.read32(FLASH_REG.SR),
    (value) => (value & SR.BSY) === 0,
  );
  if (sr === undefined) throw new SessionError("timeout", `The flash controller stayed busy for ${timeoutMs / 1000} s during ${what}.`);
  return sr;
}

/** Throws SessionError "flash" if any SR error flag is set. */
export function checkFlashErrors(sr: number, what: string): void {
  if ((sr & SR_ERRORS) === 0) return;
  throw new SessionError("flash", `${what} failed: FLASH_SR ${hex32(sr)} (${srErrorNames(sr).join(", ")}).`);
}

/** Clears EOP and every error flag (write 1 to clear). */
export async function clearFlashErrors(memory: MemoryAccess): Promise<void> {
  await memory.write32(FLASH_REG.SR, (SR_ERRORS | SR.EOP) >>> 0);
}

/** Unlocks FLASH_CR with the KEYR sequence if it is locked. */
export async function unlockFlash(memory: MemoryAccess): Promise<void> {
  if (((await memory.read32(FLASH_REG.CR)) & CR.LOCK) === 0) return;
  await memory.write32(FLASH_REG.KEYR, FLASH_KEY1);
  await memory.write32(FLASH_REG.KEYR, FLASH_KEY2);
  const cr = await memory.read32(FLASH_REG.CR);
  if ((cr & CR.LOCK) !== 0) throw new SessionError("flash", `FLASH_CR stayed locked after the unlock keys (CR ${hex32(cr)}).`);
}

/** Unlocks the option bytes with the OPTKEYR sequence. FLASH_CR must already be unlocked. */
export async function unlockOptionBytes(memory: MemoryAccess): Promise<void> {
  if (((await memory.read32(FLASH_REG.CR)) & CR.OPTLOCK) === 0) return;
  await memory.write32(FLASH_REG.OPTKEYR, OPT_KEY1);
  await memory.write32(FLASH_REG.OPTKEYR, OPT_KEY2);
  const cr = await memory.read32(FLASH_REG.CR);
  if ((cr & CR.OPTLOCK) !== 0) throw new SessionError("flash", `The option bytes stayed locked after the unlock keys (CR ${hex32(cr)}).`);
}

/** Clears every operation bit and sets LOCK and OPTLOCK. */
export async function lockFlash(memory: MemoryAccess): Promise<void> {
  await memory.write32(FLASH_REG.CR, (CR.LOCK | CR.OPTLOCK) >>> 0);
}

/** One 2 KB page in dual-bank mode. */
export interface FlashPage {
  bank: 1 | 2;
  /** Page number within its bank, 0-127. */
  index: number;
  address: number;
}

function checkInFlash(block: HexBlock): void {
  const end = block.address + block.bytes.length;
  if (block.address < FLASH_START || end > FLASH_END) {
    throw new RangeError(`Block ${hex32(block.address)}-${hex32(end - 1)} lies outside main flash ${hex32(FLASH_START)}-${hex32(FLASH_END - 1)}`);
  }
}

/** The page holding `address`, in dual-bank mode. */
export function pageAt(address: number): FlashPage {
  const offset = address - FLASH_START;
  const bank: 1 | 2 = address >= BANK2_START ? 2 : 1;
  const index = Math.floor((offset % BANK_SIZE) / PAGE_SIZE);
  return { bank, index, address: (bank === 2 ? BANK2_START : FLASH_START) + index * PAGE_SIZE };
}

/** Every page the blocks touch, in address order, each once. Throws RangeError outside main flash. Pure. */
export function pagesTouched(blocks: readonly HexBlock[]): FlashPage[] {
  const starts = new Set<number>();
  for (const block of blocks) {
    if (block.bytes.length === 0) continue;
    checkInFlash(block);
    const first = pageAt(block.address).address;
    const last = pageAt(block.address + block.bytes.length - 1).address;
    for (let page = first; page <= last; page += PAGE_SIZE) starts.add(page);
  }
  return [...starts].sort((a, b) => a - b).map(pageAt);
}

/**
 * Merges blocks into runs aligned to 8 bytes, filling gaps inside a double word with
 * 0xFF, so every double word is written exactly once. Later blocks win where blocks
 * overlap. Throws RangeError outside main flash. Pure.
 */
export function doubleWordRuns(blocks: readonly HexBlock[]): HexBlock[] {
  const sorted = blocks.filter((block) => block.bytes.length > 0).map((block, order) => ({ block, order }));
  for (const { block } of sorted) checkInFlash(block);
  sorted.sort((a, b) => a.block.address - b.block.address || a.order - b.order);

  const spans: { start: number; end: number; members: { block: HexBlock; order: number }[] }[] = [];
  for (const entry of sorted) {
    const start = entry.block.address & ~7;
    const end = (entry.block.address + entry.block.bytes.length + 7) & ~7;
    const open = spans[spans.length - 1];
    if (open && start <= open.end) {
      open.end = Math.max(open.end, end);
      open.members.push(entry);
    } else {
      spans.push({ start, end, members: [entry] });
    }
  }

  return spans.map(({ start, end, members }) => {
    const bytes = new Uint8Array(end - start).fill(0xff);
    for (const { block } of [...members].sort((a, b) => a.order - b.order)) bytes.set(block.bytes, block.address - start);
    return { address: start, bytes };
  });
}

/** Erases the given pages, one at a time. FLASH_CR is locked again afterwards. */
export async function erasePages(
  memory: MemoryAccess,
  time: TimeSource,
  pages: readonly FlashPage[],
  timeouts: FlashTimeouts = DEFAULT_FLASH_TIMEOUTS,
  onProgress?: ByteProgress,
): Promise<void> {
  const total = pages.length * PAGE_SIZE;
  await unlockFlash(memory);
  try {
    await waitFlashIdle(memory, time, timeouts.pageEraseMs, "the erase");
    await clearFlashErrors(memory);
    onProgress?.(0, total);
    for (const [done, page] of pages.entries()) {
      const setup = (CR.PER | ((page.index << CR.PNB_SHIFT) & CR.PNB_MASK) | (page.bank === 2 ? CR.BKER : 0)) >>> 0;
      await memory.write32(FLASH_REG.CR, setup);
      await memory.write32(FLASH_REG.CR, (setup | CR.STRT) >>> 0);
      const sr = await waitFlashIdle(memory, time, timeouts.pageEraseMs, `the erase of page ${page.index} in bank ${page.bank}`);
      checkFlashErrors(sr, `Erasing bank ${page.bank} page ${page.index} (${hex32(page.address)})`);
      onProgress?.((done + 1) * PAGE_SIZE, total);
    }
  } finally {
    await lockFlash(memory).catch(() => undefined);
  }
}

/** Erases both banks (MER1 | MER2). FLASH_CR is locked again afterwards. */
export async function massErase(memory: MemoryAccess, time: TimeSource, timeouts: FlashTimeouts = DEFAULT_FLASH_TIMEOUTS, onProgress?: ByteProgress): Promise<void> {
  const total = FLASH_END - FLASH_START;
  await unlockFlash(memory);
  try {
    await waitFlashIdle(memory, time, timeouts.massEraseMs, "the mass erase");
    await clearFlashErrors(memory);
    onProgress?.(0, total);
    const setup = (CR.MER1 | CR.MER2) >>> 0;
    await memory.write32(FLASH_REG.CR, setup);
    await memory.write32(FLASH_REG.CR, (setup | CR.STRT) >>> 0);
    const sr = await waitFlashIdle(memory, time, timeouts.massEraseMs, "the mass erase");
    checkFlashErrors(sr, "Mass erase");
    onProgress?.(total, total);
  } finally {
    await lockFlash(memory).catch(() => undefined);
  }
}

/**
 * Programs the blocks as 64-bit double words, low word first, polling BSY after each.
 * Partial double words are padded with 0xFF. Double words that are all 0xFF are
 * skipped: erased flash already holds them, and verify catches a page that was not
 * erased. Clears PG and sets LOCK afterwards, also on failure.
 */
export async function programBlocks(
  memory: MemoryAccess,
  time: TimeSource,
  blocks: readonly HexBlock[],
  timeouts: FlashTimeouts = DEFAULT_FLASH_TIMEOUTS,
  onProgress?: ByteProgress,
): Promise<void> {
  const runs = doubleWordRuns(blocks);
  const total = runs.reduce((sum, run) => sum + run.bytes.length, 0);
  let done = 0;
  let reported = 0;

  await unlockFlash(memory);
  try {
    await waitFlashIdle(memory, time, timeouts.doubleWordMs, "programming");
    await clearFlashErrors(memory);
    await memory.write32(FLASH_REG.CR, CR.PG);
    onProgress?.(0, total);
    for (const run of runs) {
      const view = new DataView(run.bytes.buffer, run.bytes.byteOffset, run.bytes.byteLength);
      for (let offset = 0; offset < run.bytes.length; offset += 8) {
        const low = view.getUint32(offset, true);
        const high = view.getUint32(offset + 4, true);
        if (low !== 0xffffffff || high !== 0xffffffff) {
          const address = run.address + offset;
          await memory.write32(address, low);
          await memory.write32(address + 4, high);
          const sr = await waitFlashIdle(memory, time, timeouts.doubleWordMs, `programming at ${hex32(address)}`);
          checkFlashErrors(sr, `Programming at ${hex32(address)}`);
        }
        done += 8;
        if (done - reported >= PROGRESS_STEP) {
          reported = done;
          onProgress?.(done, total);
        }
      }
    }
    if (reported !== total) onProgress?.(total, total);
  } finally {
    await lockFlash(memory).catch(() => undefined);
  }
}

/** Reads every block back. Resolves with the first differing address, or undefined when all match. */
export async function verifyBlocks(memory: MemoryAccess, blocks: readonly HexBlock[], onProgress?: ByteProgress): Promise<number | undefined> {
  const total = blocks.reduce((sum, block) => sum + block.bytes.length, 0);
  let done = 0;
  onProgress?.(0, total);
  for (const block of blocks) {
    for (let offset = 0; offset < block.bytes.length; offset += VERIFY_CHUNK) {
      const start = block.address + offset;
      const length = Math.min(VERIFY_CHUNK, block.bytes.length - offset);
      const alignedStart = start & ~3;
      const alignedEnd = (start + length + 3) & ~3;
      const read = await memory.readBlock(alignedStart, alignedEnd - alignedStart);
      for (let index = 0; index < length; index++) {
        if (read[start - alignedStart + index] !== block.bytes[offset + index]) return start + index;
      }
      done += length;
      onProgress?.(done, total);
    }
  }
  return undefined;
}
