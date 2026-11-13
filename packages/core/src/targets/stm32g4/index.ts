/**
 * STM32G4 recipes and constants for Alpha Migrate. The contract types live in
 * session.ts and are exported separately.
 */
export * as G4Registers from "./registers.js";
export { decodeOptr, planOptrChange, rdpLevelOf, OptrPlanError, type DecodedOptr, type OptrChange, type OptrPlan } from "./option-bytes.js";
export { pagesTouched, pageAt, doubleWordRuns, DEFAULT_FLASH_TIMEOUTS, type FlashPage, type FlashTimeouts } from "./flash.js";
export { formatUid } from "./identify.js";
export { SwdG4Session, toSessionError, type DebugLink, type SwdG4SessionOptions } from "./swd-session.js";
