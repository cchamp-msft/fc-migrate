export { cleanCapturedCli, SimulatedFc, type SimulatedFcProfile } from "./simulated-fc.js";
export { VirtualTime } from "./virtual-time.js";
export {
  SimulatedG4,
  FACTORY_OPTR,
  INACTIVE_PROTECTION,
  type CoreState,
  type DebugPortState,
  type SimulatedBusyTimes,
  type SimulatedG4Faults,
  type SimulatedG4Options,
  type SimulatedProtection,
} from "./simulated-g4.js";
export { SimulatedStlink, type SimulatedStlinkOptions } from "./simulated-stlink.js";
export {
  ALPHA_SCENARIOS,
  createAlphaSimulation,
  plausibleBetaflightImage,
  type AlphaScenario,
  type AlphaScenarioName,
  type AlphaSimulation,
  type AlphaSimulationOptions,
} from "./alpha-scenarios.js";
