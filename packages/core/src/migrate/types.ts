import type { ConfigDocument, ConfigScope } from "../config/document.js";
import type { FirmwareSchema } from "../schema/types.js";

/** Firmware release lines, oldest first. One rule pack exists for each adjacent pair. */
export const RELEASE_LINES = ["4.5", "2025.12", "2026.6", "2026.12"] as const;
export type ReleaseLine = (typeof RELEASE_LINES)[number];

export type Domain = "serial" | "orientation" | "motors" | "modes" | "vtx" | "osd" | "rates" | "tuning" | "filters" | "receiver" | "failsafe" | "board" | "other";

export type Outcome =
  /** Same name, value still valid. */
  | "carried"
  /** New name, same meaning. */
  | "renamed"
  /** Value changed to preserve its meaning. */
  | "converted"
  /** Recomputed on the target from the sliders that produced it. */
  | "derived"
  /** No equivalent on the target. */
  | "dropped"
  /** Could not be decided safely; the pilot must look at it. */
  | "attention"
  /** Absent from the config, but the factory value differs on the target. */
  | "default-changed"
  /** Set by the pilot's own standards. */
  | "standard"
  /** A replacement the pilot accepted from the AI, checked against the target. */
  | "suggested";

export interface PlanItem {
  id: string;
  domain: Domain;
  outcome: Outcome;
  scope: ConfigScope;
  /** Original setting name or command word. */
  sourceName: string;
  sourceValue?: string;
  targetName?: string;
  targetValue?: string;
  /** CLI line sent to the board, when there is one. */
  line?: string;
  note?: string;
  /** The original line, when it cannot be sent as it is and a replacement may be suggested. */
  failedLine?: string;
  /** Why an accepted replacement for this line was not used. */
  suggestionProblem?: string;
}

export interface PilotStandard {
  name: string;
  value: string;
}

export interface SliderFit {
  sliders: Record<string, number>;
  /** Largest difference, in PID units, between the fit and the real values. */
  maxError: number;
}

export interface ProfileTuning {
  profile: number;
  /** `sliders`: the tune is defined by the sliders. `custom`: by its raw numbers. */
  mode: "sliders" | "custom";
  summary: string;
  fit?: SliderFit;
}

export interface MigrationInput {
  sourceVersion: string;
  targetVersion: string;
  /** The board being migrated, compared with the board a target schema was captured from. */
  boardName?: string;
  /** Output of `diff all`: what the pilot changed. */
  diff: ConfigDocument;
  /** Output of `dump all`: every effective value. */
  dump: ConfigDocument;
  sourceSchema?: FirmwareSchema;
  targetSchema?: FirmwareSchema;
  standards?: readonly PilotStandard[];
  /** Item IDs of changed defaults for which the pilot wants the old value kept. */
  keepOldDefaults?: ReadonlySet<string>;
  /**
   * Replacements the pilot accepted, keyed by an item's `failedLine`. Each is checked
   * against the target schema again here and ignored if it does not pass.
   */
  suggestions?: ReadonlyMap<string, string>;
}

export interface MigrationPlan {
  sourceVersion: string;
  targetVersion: string;
  /** Version steps applied, for example `4.5 to 2025.12`. */
  steps: string[];
  items: PlanItem[];
  tuning: ProfileTuning[];
  /** Commands to send to the board, in order. Excludes the final `save`. */
  script: string[];
  counts: Record<Outcome, number>;
}
