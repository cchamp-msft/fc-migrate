/** The CMSIS-DAP layer of Alpha Migrate: a second probe type behind the same G4Session. */
export { openCmsisDapG4Session, type CmsisDapOpenOptions } from "./open-session.js";
export { CmsisDapProbe, findDapInterface, type CmsisDapProbeOptions, type DapInterface } from "./probe.js";
export { CMSIS_DAP_DEFAULT_CLOCK_KHZ, CMSIS_DAP_MODELS, CMSIS_DAP_USB_FILTERS, type CmsisDapModel } from "./models.js";
