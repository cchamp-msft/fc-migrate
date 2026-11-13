/**
 * STM32G47x/G48x register addresses and bits used over SWD. Citations are to
 * lib/main/STM32G4/Drivers/CMSIS/Device/ST/STM32G4xx/Include/stm32g474xx.h (`H:`) and
 * STM32G4xx_HAL_Driver/Inc/stm32g4xx_hal_flash.h (`HAL:`) in the Betaflight tree.
 */

/** FLASH register block (H:1251, FLASH_R_BASE). */
export const FLASH_REGS_BASE = 0x40022000;

/** FLASH register addresses (H:459-479, FLASH_TypeDef). */
export const FLASH_REG = {
  ACR: FLASH_REGS_BASE + 0x00,
  KEYR: FLASH_REGS_BASE + 0x08,
  OPTKEYR: FLASH_REGS_BASE + 0x0c,
  SR: FLASH_REGS_BASE + 0x10,
  CR: FLASH_REGS_BASE + 0x14,
  OPTR: FLASH_REGS_BASE + 0x20,
  PCROP1SR: FLASH_REGS_BASE + 0x24,
  PCROP1ER: FLASH_REGS_BASE + 0x28,
  WRP1AR: FLASH_REGS_BASE + 0x2c,
  WRP1BR: FLASH_REGS_BASE + 0x30,
  PCROP2SR: FLASH_REGS_BASE + 0x44,
  PCROP2ER: FLASH_REGS_BASE + 0x48,
  WRP2AR: FLASH_REGS_BASE + 0x4c,
  WRP2BR: FLASH_REGS_BASE + 0x50,
  SEC1R: FLASH_REGS_BASE + 0x70,
  SEC2R: FLASH_REGS_BASE + 0x74,
} as const;

/** KEYR unlock sequence (HAL:484-487). */
export const FLASH_KEY1 = 0x45670123;
export const FLASH_KEY2 = 0xcdef89ab;
/** OPTKEYR unlock sequence (HAL:490-493). */
export const OPT_KEY1 = 0x08192a3b;
export const OPT_KEY2 = 0x4c5d6e7f;

/** FLASH_CR bits (H:5158-5206). */
export const CR = {
  PG: 1 << 0,
  PER: 1 << 1,
  MER1: 1 << 2,
  PNB_SHIFT: 3,
  PNB_MASK: 0x7f << 3,
  BKER: 1 << 11,
  MER2: 1 << 15,
  STRT: 1 << 16,
  OPTSTRT: 1 << 17,
  FSTPG: 1 << 18,
  OBL_LAUNCH: 1 << 27,
  OPTLOCK: 1 << 30,
  LOCK: 0x80000000,
} as const;

/** FLASH_SR bits (H:5120-5154). */
export const SR = {
  EOP: 1 << 0,
  OPERR: 1 << 1,
  PROGERR: 1 << 3,
  WRPERR: 1 << 4,
  PGAERR: 1 << 5,
  SIZERR: 1 << 6,
  PGSERR: 1 << 7,
  MISERR: 1 << 8,
  FASTERR: 1 << 9,
  RDERR: 1 << 14,
  OPTVERR: 1 << 15,
  BSY: 1 << 16,
} as const;

/** Every SR error flag (HAL:521, FLASH_FLAG_SR_ERRORS). Write 1 to clear. */
export const SR_ERRORS = SR.OPERR | SR.PROGERR | SR.WRPERR | SR.PGAERR | SR.SIZERR | SR.PGSERR | SR.MISERR | SR.FASTERR | SR.RDERR | SR.OPTVERR;

const SR_ERROR_NAMES: readonly [number, string][] = [
  [SR.OPERR, "OPERR"],
  [SR.PROGERR, "PROGERR"],
  [SR.WRPERR, "WRPERR"],
  [SR.PGAERR, "PGAERR"],
  [SR.SIZERR, "SIZERR"],
  [SR.PGSERR, "PGSERR"],
  [SR.MISERR, "MISERR"],
  [SR.FASTERR, "FASTERR"],
  [SR.RDERR, "RDERR"],
  [SR.OPTVERR, "OPTVERR"],
];

/** Names of the error flags set in an SR value, for messages. */
export function srErrorNames(sr: number): string[] {
  return SR_ERROR_NAMES.filter(([bit]) => (sr & bit) !== 0).map(([, name]) => name);
}

/** FLASH_OPTR fields (H:5237-5295). */
export const OPTR = {
  RDP_MASK: 0xff,
  BFB2: 1 << 20,
  DBANK: 1 << 22,
  nBOOT1: 1 << 23,
  nSWBOOT0: 1 << 26,
  nBOOT0: 1 << 27,
} as const;

/** RDP Level 0: no read protection. */
export const RDP_LEVEL_0 = 0xaa;
/**
 * RDP Level 2: permanent. Only ever used to *recognise* the value. No code may write
 * an OPTR value whose low byte is this; option-bytes.ts enforces it.
 */
export const RDP_LEVEL_2 = 0xcc;

/** SEC1R BOOT_LOCK (H:5358). */
export const SEC1R_BOOT_LOCK = 1 << 16;

/** DBGMCU (H:1325, H:3121). DEV_ID is IDCODE & 0xFFF. */
export const DBGMCU_IDCODE = 0xe0042000;
/** DBGMCU APB1 freeze register 1 (H:383): stop the watchdogs while the core is halted. */
export const DBGMCU_APB1FZR1 = 0xe0042008;
export const APB1FZR1_DBG_WWDG_STOP = 1 << 11;
export const APB1FZR1_DBG_IWDG_STOP = 1 << 12;
export const DEV_ID_MASK = 0xfff;
/** STM32G47x/G48x. */
export const DEV_ID_G47X = 0x469;

/** System-memory identity words (H:1327-1329). */
export const PACKAGE_BASE = 0x1fff7500;
export const UID_BASE = 0x1fff7590;
export const FLASHSIZE_BASE = 0x1fff75e0;

/** Main flash on the 512 KB part, dual-bank mode (DBANK = 1, HAL:849-859). */
export const FLASH_START = 0x08000000;
export const FLASH_SIZE_KB = 512;
export const FLASH_SIZE = FLASH_SIZE_KB * 1024;
export const FLASH_END = FLASH_START + FLASH_SIZE;
export const BANK_SIZE = FLASH_SIZE / 2;
export const BANK2_START = FLASH_START + BANK_SIZE;
export const PAGE_SIZE = 2048;
export const PAGES_PER_BANK = 128;

/** Betaflight's 8 KB config area on G474 (stm32_flash_g474.ld:14-16); its first byte is 0xBE when a config is stored. */
export const CONFIG_AREA = 0x08004000;
/** How much of the start of flash readAll returns. */
export const FLASH_HEAD_LENGTH = 1024;
