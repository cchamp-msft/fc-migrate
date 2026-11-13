import { openStlinkG4Session } from "@bf-migrate/core";
import { ALPHA_SCENARIOS, createAlphaSimulation, type AlphaScenarioName } from "@bf-migrate/core/testing";
import type { ProbeSource } from "../stores/alpha";

export type DemoScenarioId = AlphaScenarioName;

/** Board states a pilot can try, most common first. */
const ORDER: AlphaScenarioName[] = ["stockAlpha073", "brickedPartialFlash", "oldAlphaSwBoot", "blankAfterErase", "migratedBetaflight", "wrongChip", "wiringFault", "level2"];

export const DEMO_SCENARIOS: { id: DemoScenarioId; label: string; description: string }[] = ORDER.map((id) => ({
  id,
  label: ALPHA_SCENARIOS[id].title,
  description: ALPHA_SCENARIOS[id].description,
}));

/**
 * A simulated ST-Link wired to a simulated G4 Alpha. It runs the same session code as a
 * real probe; only the USB device underneath is replaced. The chip keeps its state across
 * reconnects, so an erase stays erased.
 */
export function createDemoSource(id: DemoScenarioId): ProbeSource {
  const simulation = createAlphaSimulation(id);
  return {
    simulated: true,
    // The simulated chip is the only place the demo stand-in may be written.
    open: (mode, onAttached) => openStlinkG4Session(simulation.probe, { mode, onAttached, allowDemoImage: true }),
    pressReset: () => simulation.chip.pressReset(),
    releaseReset: () => simulation.chip.releaseReset(),
  };
}
