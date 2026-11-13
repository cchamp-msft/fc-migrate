import { scopeKey, type ConfigDocument, type ConfigScope } from "../config/document.js";
import { convertThrough, packsBetween, releaseLineOf } from "../migrate/rules.js";
import type { FirmwareSchema } from "../schema/types.js";
import { validateValue } from "../schema/validate.js";

/** Prop size class, which sets how high dynamic idle holds the motors. */
export type QuadSize = "small" | "large";
export type Feel = "default" | "smooth";

export interface BootstrapChoices {
  /** `small`: 2 to 3.5 inch. `large`: 4 to 5 inch. */
  size: QuadSize;
  feel: Feel;
  windResistant: boolean;
}

export interface BootstrapInput {
  firmwareVersion: string;
  /** Output of `dump all`: every effective value. */
  dump: ConfigDocument;
  /** The connected board's own settings list. */
  schema: FirmwareSchema;
}

export interface Readiness {
  ready: boolean;
  /** Each reason the bootstrapper cannot run, in plain words. */
  problems: string[];
}

export interface BootstrapChange {
  scope: ConfigScope;
  name: string;
  from: string | undefined;
  to: string;
  reason: string;
  /** False when the board already has this value, so no line is sent. */
  changed: boolean;
}

export interface BootstrapPlan {
  changes: BootstrapChange[];
  /** What the firmware rewrites on its own when `simplified_tuning apply` runs. */
  recomputed: string[];
  /** Settings the pilot asked for that this firmware cannot take, with why. */
  skipped: { name: string; reason: string }[];
  activeProfile: number;
  /** Commands to send, in order. Excludes the final `save`. */
  script: string[];
}

/** Dynamic idle, in hundreds of rpm. */
const DYN_IDLE: Record<QuadSize, number> = { small: 30, large: 20 };

/** The sliders that define PIDs, under any release's names. */
const PID_SLIDER = /^simplified_(master_multiplier|i_gain|d_gain|pi_gain|dmax_gain|d_max_gain|feedforward_gain|pitch_d_gain|pitch_pi_gain|roll_pitch_ratio)$/;

/** Everything `simplified_tuning apply` can rewrite, plus what the bootstrapper sets. */
const RESTORABLE = /^(p|i|d|f|d_min|d_max)_(roll|pitch|yaw)$|^simplified_|^(dterm_lpf|gyro_lpf)|^(throttle_boost|dyn_idle_min_rpm|thrust_linear)$/;

interface Wanted {
  /** Name and value in 4.5 terms, carried to the board's release by the migration rules. */
  name: string;
  value: string;
  reason: string;
  everyProfile?: boolean;
}

function wantedValues(choices: BootstrapChoices): Wanted[] {
  const idle = DYN_IDLE[choices.size];
  const sizeLabel = choices.size === "small" ? "2 to 3.5 inch" : "4 to 5 inch";
  const wanted: Wanted[] = [
    { name: "throttle_boost", value: "0", reason: "Throttle boost off.", everyProfile: true },
    { name: "dyn_idle_min_rpm", value: String(idle), reason: `Dynamic idle at ${(idle * 100).toLocaleString("en-US")} rpm for a ${sizeLabel} quad.`, everyProfile: true },
    { name: "simplified_pids_mode", value: "RPY", reason: "PIDs follow the sliders on all three axes." },
    { name: "simplified_dterm_filter", value: "ON", reason: "D-term filtering follows its slider." },
  ];
  if (choices.feel === "smooth") {
    wanted.push(
      { name: "simplified_d_gain", value: "115", reason: "Smooth: more damping (D slider 1.15)." },
      { name: "simplified_dterm_filter_multiplier", value: "90", reason: "Smooth: a little more D-term filtering (slider 0.90)." },
    );
  }
  if (choices.windResistant) {
    wanted.push(
      { name: "simplified_i_gain", value: "125", reason: "Wind: more I to hold attitude in gusts (slider 1.25)." },
      { name: "simplified_dmax_gain", value: "0", reason: "Wind: steady D with no dynamic boost (D max slider 0)." },
      { name: "thrust_linear", value: "20", reason: "Wind: thrust linearization 20%, for steadier throttle in gusts." },
    );
  }
  return wanted;
}

type Values = (name: string, scope: ConfigScope) => string | undefined;

/** One lookup table per dump, keyed by scope and name. */
function valuesOf(dump: ConfigDocument): Values {
  const table = new Map<string, string>();
  for (const entry of dump.entries) if (entry.kind === "set") table.set(`${scopeKey(entry.scope)}|${entry.name}`, entry.value);
  return (name, scope) => table.get(`${scopeKey(scope)}|${name}`);
}

function profileIndexes(dump: ConfigDocument): number[] {
  const indexes = new Set<number>();
  for (const entry of dump.entries) if (entry.scope.kind === "profile") indexes.add(entry.scope.index);
  return [...indexes].sort((a, b) => a - b);
}

function activeProfileOf(dump: ConfigDocument, profiles: readonly number[]): number {
  return dump.metadata.activeProfile ?? profiles[0] ?? 0;
}

/** Checks that the quad can take the bootstrap. Bidirectional DShot is required, never assumed. */
export function checkBootstrapReady(input: BootstrapInput): Readiness {
  const problems: string[] = [];
  const master: ConfigScope = { kind: "master" };
  const valueOf = valuesOf(input.dump);

  if (!releaseLineOf(input.firmwareVersion)) problems.push(`Betaflight ${input.firmwareVersion} is not supported. The bootstrapper starts at 4.5.`);
  if (!input.schema.commands.simplified_tuning) problems.push("This firmware was built without simplified tuning, which the bootstrapper uses to reset the PIDs.");
  if (!input.schema.settings.dyn_idle_min_rpm) problems.push("This firmware was built without dynamic idle.");

  const protocol = valueOf("motor_pwm_protocol", master);
  const bidir = valueOf("dshot_bidir", master);
  if (!protocol?.toUpperCase().startsWith("DSHOT")) {
    problems.push(`The motor protocol is ${protocol ?? "unknown"}. Bidirectional DShot needs a DShot protocol, such as DSHOT300 or DSHOT600.`);
  } else if (bidir?.toUpperCase() !== "ON") {
    problems.push("Bidirectional DShot is off. Dynamic idle needs the motor rpm it reports. Turn it on only if your ESC firmware supports it (BLHeli_32, AM32 or Bluejay), check the motors spin normally, then come back.");
  }

  return { ready: problems.length === 0, problems };
}

/** Builds the bootstrap. Nothing here touches a board. */
export function planBootstrap(input: BootstrapInput, choices: BootstrapChoices): BootstrapPlan {
  const line = releaseLineOf(input.firmwareVersion);
  if (!line) throw new Error(`Betaflight ${input.firmwareVersion} is not supported.`);

  const valueOf = valuesOf(input.dump);
  const profiles = profileIndexes(input.dump);
  const activeProfile = activeProfileOf(input.dump, profiles);
  const active: ConfigScope = { kind: "profile", index: activeProfile };
  const packs = packsBetween("4.5", line);
  const skipped: BootstrapPlan["skipped"] = [];

  // name -> value and reason, for the active profile; later entries win.
  const forActive = new Map<string, { value: string; reason: string }>();
  const forEvery = new Map<string, { value: string; reason: string }>();

  // Every PID slider back to this firmware's default, so the PIDs become the defaults.
  for (const setting of Object.values(input.schema.settings)) {
    if (PID_SLIDER.test(setting.name)) forActive.set(setting.name, { value: setting.defaultValue, reason: "Slider back to its default." });
  }
  const filterSlider = input.schema.settings.simplified_dterm_filter_multiplier;
  if (filterSlider) forActive.set(filterSlider.name, { value: filterSlider.defaultValue, reason: "Slider back to its default." });

  for (const want of wantedValues(choices)) {
    const moved = convertThrough(want.name, want.value, packs, { effective: (name) => valueOf(name, active) });
    const setting = moved ? input.schema.settings[moved.name] : undefined;
    if (!moved || !setting) {
      skipped.push({ name: want.name, reason: `Not available on ${input.firmwareVersion} for this build.` });
      continue;
    }
    const verdict = validateValue(setting, moved.value);
    if (!verdict.ok) {
      skipped.push({ name: moved.name, reason: verdict.reason });
      continue;
    }
    const converted = moved.value !== want.value ? ` On ${line} that is ${moved.value}.` : "";
    (want.everyProfile ? forEvery : forActive).set(moved.name, { value: moved.value, reason: want.reason + converted });
  }

  const changes: BootstrapChange[] = [];
  for (const index of profiles) {
    const scope: ConfigScope = { kind: "profile", index };
    const entries = index === activeProfile ? [...forEvery, ...forActive] : [...forEvery];
    for (const [name, { value, reason }] of entries) {
      const from = valueOf(name, scope);
      changes.push({ scope, name, from, to: value, reason, changed: from?.toLowerCase() !== value.toLowerCase() });
    }
  }

  const script = ["batch start"];
  for (const index of profiles) {
    const lines = changes.filter((change) => change.changed && change.scope.kind === "profile" && change.scope.index === index);
    if (lines.length === 0) continue;
    script.push(`profile ${index}`, ...lines.map((change) => `set ${change.name} = ${change.to}`));
  }
  // Recomputes PIDs and D-term filters from the sliders, on every profile in slider mode.
  script.push("simplified_tuning apply", `profile ${activeProfile}`, "batch end");

  return { changes, recomputed: recomputedBy(input, valueOf, profiles, activeProfile), skipped, activeProfile, script };
}

/** Lists what `simplified_tuning apply` rewrites beyond the values set directly. */
function recomputedBy(input: BootstrapInput, valueOf: Values, profiles: readonly number[], activeProfile: number): string[] {
  const notes = [`PIDs and D-term filters of PID profile ${activeProfile + 1}, from its sliders.`];
  for (const index of profiles) {
    if (index === activeProfile) continue;
    const scope: ConfigScope = { kind: "profile", index };
    const parts = [
      ...((valueOf("simplified_pids_mode", scope) ?? "OFF").toUpperCase() !== "OFF" ? ["PIDs"] : []),
      ...(valueOf("simplified_dterm_filter", scope)?.toUpperCase() === "ON" ? ["D-term filters"] : []),
    ];
    if (parts.length) notes.push(`${parts.join(" and ")} of PID profile ${index + 1}, from its own slider positions.`);
  }
  if (input.schema.settings.simplified_gyro_filter && valueOf("simplified_gyro_filter", { kind: "master" })?.toUpperCase() === "ON") {
    notes.push("Gyro filters, from the gyro filter slider.");
  }
  return notes;
}

/**
 * Commands that put back every value the bootstrap can change, on every profile.
 * Sent without `simplified_tuning apply`, so restored PID numbers stay exactly as they were.
 */
export function buildRestoreScript(dump: ConfigDocument): string[] {
  const profiles = profileIndexes(dump);
  const script = ["batch start"];
  const setsIn = (scope: ConfigScope) => dump.entries.filter((entry) => entry.kind === "set" && RESTORABLE.test(entry.name) && scopeKey(entry.scope) === scopeKey(scope));

  for (const entry of setsIn({ kind: "master" })) if (entry.kind === "set") script.push(`set ${entry.name} = ${entry.value}`);
  for (const index of profiles) {
    const lines = setsIn({ kind: "profile", index });
    if (lines.length === 0) continue;
    script.push(`profile ${index}`);
    for (const entry of lines) if (entry.kind === "set") script.push(`set ${entry.name} = ${entry.value}`);
  }
  script.push(`profile ${activeProfileOf(dump, profiles)}`, "batch end");
  return script;
}
