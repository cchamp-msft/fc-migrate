import { isSendableLine, parseSetCommand } from "../llm/proposals.js";
import { scopeKey, type CommandLine, type ConfigDocument, type ConfigScope, type SetLine } from "../config/document.js";
import type { SettingSchema } from "../schema/types.js";
import { validateValue } from "../schema/validate.js";
import { domainOfCommand, domainOfSetting } from "./domains.js";
import { convertThrough, isBefore, packsBetween, releaseLineOf, type RuleContext, type RulePack } from "./rules.js";
import { AXES, convertD, convertDMaxAdvance, fitSliders, matchesSliders, type Axis, type PidSet, type Sliders } from "./tuning.js";
import type { MigrationInput, MigrationPlan, Outcome, PlanItem, ProfileTuning } from "./types.js";

/** Reports a migration the rule packs cannot perform. */
export class UnsupportedMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMigrationError";
  }
}

/** Lines that identify one physical chip rather than configure anything. */
const IDENTITY_COMMANDS = new Set(["mcu_id", "signature"]);
const PIN_COMMANDS = new Set(["resource", "timer", "dma"]);
const FORK_ONLY_NOTE = "Only exists on a custom firmware fork, not in official Betaflight.";

/** Replaced by the tuning step, so the generic rules must leave them alone. */
const D_SETTINGS = /^(d|d_min)_(roll|pitch|yaw)$/;
const DERIVED_FROM_SLIDERS = /^(p|i|d|f|d_min)_(roll|pitch|yaw)$/;
/** Covered by the tuning step or by a rule, so not reported as a changed default. */
const NOT_A_DEFAULT_CHANGE = /^(d|d_min|d_max)_(roll|pitch|yaw)$|^osd_warn_bitmask$|^osd_.*_pos$|^(gyro_\d_)|^simplified_/;
const GYRO_ALIGN = /^gyro_\d_(sensor_align|align_)/;
/** PID numbers and sliders, which the tuning step owns. */
const PID_TUNE = /^(p|i|d|f|d_min|d_max|s)_(roll|pitch|yaw)$|^simplified_/;
const SECTION_NAMES: Record<string, string> = { master: "the main section", profile: "a PID profile", rateprofile: "a rate profile", battery_profile: "a battery profile" };

interface Values {
  get(name: string, scope: ConfigScope): string | undefined;
}

function indexValues(document: ConfigDocument): Values {
  const table = new Map<string, string>();
  for (const entry of document.entries) {
    if (entry.kind === "set") table.set(`${scopeKey(entry.scope)}|${entry.name}`, entry.value);
  }
  return {
    get(name, scope) {
      return table.get(`${scopeKey(scope)}|${name}`) ?? table.get(`master|${name}`);
    },
  };
}

function profileIndexes(document: ConfigDocument, kind: "profile" | "rateprofile"): number[] {
  const indexes = new Set<number>();
  for (const entry of document.entries) if (entry.scope.kind === kind) indexes.add(entry.scope.index);
  return [...indexes].sort((a, b) => a - b);
}

interface WorkLine {
  item: PlanItem;
  name: string;
  value: string;
}

function setLine(name: string, value: string): string {
  return `set ${name} = ${value}`;
}

class PlanBuilder {
  readonly items: PlanItem[] = [];
  private nextId = 1;

  add(item: Omit<PlanItem, "id">): PlanItem {
    const created = { ...item, id: `item-${this.nextId++}` };
    this.items.push(created);
    return created;
  }
}

function readPids(values: Values, scope: ConfigScope): PidSet | undefined {
  const read = (name: string) => {
    const raw = values.get(name, scope);
    return raw === undefined ? undefined : Number(raw);
  };
  const result = {} as PidSet;
  for (const axis of AXES) {
    const [p, i, d, f, dMin] = [read(`p_${axis}`), read(`i_${axis}`), read(`d_${axis}`), read(`f_${axis}`), read(`d_min_${axis}`)];
    if (p === undefined || i === undefined || d === undefined || f === undefined || dMin === undefined) return undefined;
    result[axis] = { p, i, d, f, dMin };
  }
  return result;
}

function readSliders(values: Values, scope: ConfigScope): Sliders | undefined {
  const read = (name: string) => {
    const raw = values.get(name, scope);
    return raw === undefined ? undefined : Number(raw);
  };
  const sliders = {
    master: read("simplified_master_multiplier"),
    i: read("simplified_i_gain"),
    d: read("simplified_d_gain"),
    pi: read("simplified_pi_gain"),
    dMax: read("simplified_dmax_gain"),
    feedforward: read("simplified_feedforward_gain"),
    pitchD: read("simplified_pitch_d_gain"),
    pitchPi: read("simplified_pitch_pi_gain"),
  };
  return Object.values(sliders).some((value) => value === undefined) ? undefined : (sliders as Sliders);
}

function axesForMode(mode: string | undefined): readonly Axis[] {
  if (mode === "RP") return ["roll", "pitch"];
  if (mode === "RPY") return AXES;
  return [];
}

interface TuningResult {
  summaries: ProfileTuning[];
  /** `scope|name` keys of diff lines the tuning step has already handled. */
  handled: Set<string>;
  needsApply: boolean;
}

/** Applies the 4.5 to 2025.12 meaning change of D across every PID profile. */
function migrateTuning45(input: MigrationInput, values: Values, plan: PlanBuilder, work: WorkLine[]): TuningResult {
  const handled = new Set<string>();
  const summaries: ProfileTuning[] = [];
  let needsApply = false;
  const diffValues = indexValues(input.diff);
  const diffHas = (name: string, scope: ConfigScope) => input.diff.entries.some((entry) => entry.kind === "set" && entry.name === name && scopeKey(entry.scope) === scopeKey(scope));

  for (const index of profileIndexes(input.dump, "profile")) {
    const scope: ConfigScope = { kind: "profile", index };
    const pids = readPids(values, scope);
    const sliders = readSliders(values, scope);
    const mode = values.get("simplified_pids_mode", scope);
    if (!pids) continue;

    const axes = axesForMode(mode);
    const slidersOwnTune = !!sliders && axes.length > 0 && matchesSliders(pids, sliders, axes);

    if (slidersOwnTune) {
      for (const entry of input.diff.entries) {
        if (entry.kind !== "set" || scopeKey(entry.scope) !== scopeKey(scope) || !DERIVED_FROM_SLIDERS.test(entry.name)) continue;
        handled.add(`${scopeKey(scope)}|${entry.name}`);
        plan.add({ domain: "tuning", outcome: "derived", scope, sourceName: entry.name, sourceValue: entry.value, note: "Recomputed from your sliders on the new firmware." });
      }
      const sliderChanged = input.diff.entries.some((entry) => entry.kind === "set" && scopeKey(entry.scope) === scopeKey(scope) && entry.name.startsWith("simplified_"));
      needsApply ||= sliderChanged;
      summaries.push({ profile: index, mode: "sliders", summary: sliderChanged ? "Your slider positions carry over and the firmware recomputes the PIDs from them." : "Sliders are at their defaults, so the new firmware's defaults apply." });
      continue;
    }

    const fit = fitSliders(pids);
    summaries.push({ profile: index, mode: "custom", fit, summary: `Custom PIDs. D is converted to the new base and peak meaning. Sliders could reproduce this within ${fit.maxError} PID units.` });

    for (const axis of AXES) {
      const before = pids[axis];
      const after = convertD(before.d, before.dMin);
      const dKey = `d_${axis}`;
      const minKey = `d_min_${axis}`;
      handled.add(`${scopeKey(scope)}|${dKey}`);
      handled.add(`${scopeKey(scope)}|${minKey}`);
      if (!diffHas(dKey, scope) && !diffHas(minKey, scope)) continue;
      const domain = "tuning" as const;
      const note = "D changed meaning at 2025.12: d is now the base, and d_max the peak.";
      work.push({ name: dKey, value: String(after.d), item: plan.add({ domain, outcome: "converted", scope, sourceName: dKey, sourceValue: String(before.d), targetName: dKey, targetValue: String(after.d), note }) });
      const dMaxKey = `d_max_${axis}`;
      work.push({ name: dMaxKey, value: String(after.dMax), item: plan.add({ domain, outcome: "converted", scope, sourceName: minKey, sourceValue: String(before.dMin), targetName: dMaxKey, targetValue: String(after.dMax), note }) });
    }

    if (mode !== "OFF") {
      work.push({ name: "simplified_pids_mode", value: "OFF", item: plan.add({ domain: "tuning", outcome: "converted", scope, sourceName: "simplified_pids_mode", sourceValue: mode, targetName: "simplified_pids_mode", targetValue: "OFF", note: "Your PIDs no longer match the sliders, so sliders are turned off to keep your numbers." }) });
      handled.add(`${scopeKey(scope)}|simplified_pids_mode`);
    }

    const gain = diffValues.get("d_max_gain", scope);
    const advance = diffValues.get("d_max_advance", scope);
    if (diffHas("d_max_gain", scope) || diffHas("d_max_advance", scope)) {
      const effectiveGain = Number(gain ?? values.get("d_max_gain", scope) ?? 37);
      const effectiveAdvance = Number(advance ?? values.get("d_max_advance", scope) ?? 20);
      const converted = convertDMaxAdvance(effectiveGain, effectiveAdvance);
      handled.add(`${scopeKey(scope)}|d_max_advance`);
      work.push({ name: "d_max_advance", value: String(converted), item: plan.add({ domain: "tuning", outcome: "converted", scope, sourceName: "d_max_advance", sourceValue: String(effectiveAdvance), targetName: "d_max_advance", targetValue: String(converted), note: "Advance no longer scales with gain, so it was multiplied through." }) });
    }
  }

  return { summaries, handled, needsApply };
}

function applyRules(entry: SetLine, packs: readonly RulePack[], context: RuleContext, plan: PlanBuilder, work: WorkLine[]): void {
  let name = entry.name;
  let value = entry.value;
  let outcome: Outcome = "carried";
  let note: string | undefined;

  for (const pack of packs) {
    for (const rule of pack.rules) {
      if (rule.kind === "rename" && rule.from === name) {
        name = rule.to;
        if (outcome === "carried") outcome = "renamed";
        note = rule.note ?? note;
      } else if (rule.kind === "convert" && rule.from === name) {
        const converted = rule.convert(value, context);
        if (converted === undefined) {
          plan.add({ domain: domainOfSetting(entry.name), outcome: "dropped", scope: entry.scope, sourceName: entry.name, sourceValue: entry.value, note: rule.dropNote ?? rule.note });
          return;
        }
        value = converted;
        if (rule.to) name = rule.to;
        outcome = "converted";
        note = rule.note;
      } else if (rule.kind === "drop" && rule.name === name) {
        plan.add({ domain: domainOfSetting(entry.name), outcome: "dropped", scope: entry.scope, sourceName: entry.name, sourceValue: entry.value, note: rule.reason });
        return;
      } else if (rule.kind === "attention" && rule.name === name) {
        outcome = "attention";
        note = rule.reason;
      }
    }
  }

  const isGyroAlign = GYRO_ALIGN.test(entry.name);
  const item = plan.add({ domain: domainOfSetting(entry.name), outcome, scope: entry.scope, sourceName: entry.name, sourceValue: entry.value, targetName: name, targetValue: value, note });
  if (isGyroAlign) return;
  work.push({ name, value, item });
}

function validateAgainstTarget(work: WorkLine[], input: MigrationInput): WorkLine[] {
  const { targetSchema, targetVersion, boardName } = input;
  const settings: Record<string, SettingSchema> | undefined = targetSchema?.settings;
  if (!settings) return work;
  // A schema lists only what its own build compiled in, so a board with GPS or LEDs
  // has settings another board's capture never saw. Its firmware gets to decide those.
  const coversThisBoard = !targetSchema?.capturedFrom || targetSchema.capturedFrom === boardName;
  const kept: WorkLine[] = [];
  for (const line of work) {
    const setting = settings[line.name.toLowerCase()];
    if (!setting && !coversThisBoard && !line.item.sourceName.startsWith("extra_")) {
      line.item.note ??= `Not in the settings list captured from ${targetSchema?.capturedFrom}, so it is sent and this board's firmware decides.`;
      kept.push(line);
      continue;
    }
    if (!setting) {
      line.item.outcome = "dropped";
      line.item.note = line.item.sourceName.startsWith("extra_") ? FORK_ONLY_NOTE : `Not available on ${targetVersion} for this build.`;
      line.item.targetName = undefined;
      line.item.targetValue = undefined;
      continue;
    }
    const verdict = validateValue(setting, line.value);
    if (!verdict.ok) {
      line.item.outcome = "attention";
      line.item.note = `Rejected by ${targetVersion}: ${verdict.reason}. This line will not be sent.`;
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/** Why an accepted replacement cannot be used, or undefined when it can. */
function replacementProblem(item: PlanItem, setting: SettingSchema | undefined, parsed: { name: string; value: string } | undefined, input: MigrationInput, work: readonly WorkLine[]): string | undefined {
  if (!parsed) return "The replacement is not a set command.";
  if (!setting) return `${parsed.name} does not exist on ${input.targetVersion}.`;
  const verdict = validateValue(setting, parsed.value);
  if (!verdict.ok) return `${verdict.reason}.`;
  // Moving a value to another section would change what it applies to.
  if (setting.scope !== item.scope.kind) return `${setting.name} belongs in ${SECTION_NAMES[setting.scope]}, not ${SECTION_NAMES[item.scope.kind]} like the original line.`;
  if (input.standards?.some((standard) => standard.name === setting.name)) return `Your standard for ${setting.name} applies instead.`;
  if (work.some((line) => line.name === setting.name && scopeKey(line.item.scope) === scopeKey(item.scope))) return `${setting.name} is already set by your configuration.`;
  return undefined;
}

/**
 * Marks lines that will not reach the board as candidates for a suggested
 * replacement, then sends the replacements the pilot accepted. PID numbers,
 * sliders and gyro alignment are left out: other steps own them on purpose.
 */
function applySuggestions(input: MigrationInput, plan: PlanBuilder, work: WorkLine[]): void {
  const sent = new Set(work.map((line) => line.item));
  for (const item of plan.items) {
    if (item.outcome !== "dropped" && item.outcome !== "attention") continue;
    if (sent.has(item) || item.line !== undefined || item.sourceValue === undefined) continue;
    if (PID_TUNE.test(item.sourceName) || GYRO_ALIGN.test(item.sourceName)) continue;
    item.failedLine = setLine(item.sourceName, item.sourceValue);

    const replacement = input.suggestions?.get(item.failedLine);
    if (replacement === undefined) continue;
    // Checked again here, because a suggestion map can come from anywhere.
    const parsed = isSendableLine(replacement) ? parseSetCommand(replacement) : undefined;
    const setting = parsed ? input.targetSchema?.settings[parsed.name] : undefined;
    const problem = replacementProblem(item, setting, parsed, input, work);
    if (problem || !setting || !parsed) {
      item.suggestionProblem = problem;
      continue;
    }

    item.outcome = "suggested";
    item.targetName = setting.name;
    item.targetValue = parsed.value;
    item.note = `Replacement you accepted from the AI, checked against ${input.targetVersion}.`;
    work.push({ name: setting.name, value: parsed.value, item });
  }
}

function addDefaultChanges(input: MigrationInput, packs: readonly RulePack[], values: Values, plan: PlanBuilder, work: WorkLine[]): void {
  const { sourceSchema, targetSchema } = input;
  if (!sourceSchema || !targetSchema) return;

  const scopeList = (kind: "master" | "profile" | "rateprofile"): ConfigScope[] =>
    kind === "master" ? [{ kind: "master" }] : profileIndexes(input.dump, kind).map((index) => ({ kind, index }));
  const inDiff = new Set(input.diff.entries.filter((entry): entry is SetLine => entry.kind === "set").map((entry) => entry.name));

  for (const source of Object.values(sourceSchema.settings)) {
    if (inDiff.has(source.name) || NOT_A_DEFAULT_CHANGE.test(source.name)) continue;
    // Compare like with like: a renamed or rescaled setting's old default must be
    // expressed the way the target firmware would read it.
    const moved = convertThrough(source.name, source.defaultValue, packs, { effective: (name) => values.get(name, { kind: "master" }) });
    if (!moved) continue;
    const target = targetSchema.settings[moved.name];
    if (!target || target.defaultValue === moved.value) continue;
    if (source.scope === "battery_profile" || target.scope === "battery_profile") continue;

    const scope: ConfigScope = target.scope === "master" ? { kind: "master" } : { kind: target.scope, index: 0 };
    const item = plan.add({
      domain: domainOfSetting(source.name),
      outcome: "default-changed",
      scope,
      sourceName: source.name,
      sourceValue: moved.value,
      targetName: moved.name,
      targetValue: target.defaultValue,
      note: `Default was ${moved.value}, now ${target.defaultValue}.`,
    });

    if (input.keepOldDefaults?.has(item.id) && validateValue(target, moved.value).ok) {
      for (const each of scopeList(target.scope as "master" | "profile" | "rateprofile")) {
        work.push({ name: moved.name, value: moved.value, item: { ...item, scope: each } });
      }
      item.note = `Keeping the old default of ${moved.value}.`;
      item.targetValue = moved.value;
    }
  }
}

function applyStandards(input: MigrationInput, plan: PlanBuilder, work: WorkLine[]): WorkLine[] {
  let result = work;
  for (const standard of input.standards ?? []) {
    const setting = input.targetSchema?.settings[standard.name];
    if (input.targetSchema && !setting) {
      plan.add({ domain: domainOfSetting(standard.name), outcome: "attention", scope: { kind: "master" }, sourceName: standard.name, targetValue: standard.value, note: `Your standard cannot be applied: ${standard.name} does not exist on ${input.targetVersion}.` });
      continue;
    }
    if (setting && !validateValue(setting, standard.value).ok) {
      plan.add({ domain: domainOfSetting(standard.name), outcome: "attention", scope: { kind: "master" }, sourceName: standard.name, targetValue: standard.value, note: `Your standard value is not valid on ${input.targetVersion}.` });
      continue;
    }

    result = result.filter((line) => line.name !== standard.name);
    const kind = setting?.scope ?? "master";
    const scopes: ConfigScope[] =
      kind === "master" || kind === "battery_profile" ? [{ kind: "master" }] : profileIndexes(input.dump, kind).map((index) => ({ kind, index }));
    for (const scope of scopes) {
      const item = plan.add({ domain: domainOfSetting(standard.name), outcome: "standard", scope, sourceName: standard.name, targetName: standard.name, targetValue: standard.value, note: "Your pilot standard." });
      result.push({ name: standard.name, value: standard.value, item });
    }
  }
  return result;
}

function addCommands(input: MigrationInput, plan: PlanBuilder): CommandLine[] {
  const sent: CommandLine[] = [];
  for (const entry of input.diff.entries) {
    if (entry.kind !== "command") continue;
    if (IDENTITY_COMMANDS.has(entry.command)) continue;
    const isPin = PIN_COMMANDS.has(entry.command);
    plan.add({
      domain: domainOfCommand(entry.command),
      outcome: isPin ? "attention" : "carried",
      scope: { kind: "master" },
      sourceName: entry.command,
      sourceValue: entry.args.join(" "),
      line: entry.raw,
      note: isPin ? "Custom pin mapping. Confirm it still matches your wiring on the new firmware." : undefined,
    });
    sent.push(entry);
  }
  return sent;
}

function buildScript(commands: readonly CommandLine[], work: readonly WorkLine[], input: MigrationInput, needsApply: boolean): string[] {
  const script = ["batch start", "defaults nosave"];
  for (const command of commands) script.push(command.raw);

  const emit = (lines: readonly WorkLine[]) => {
    for (const line of lines) {
      const text = setLine(line.name, line.value);
      line.item.line = text;
      script.push(text);
    }
  };

  emit(work.filter((line) => line.item.scope.kind === "master"));

  for (const kind of ["profile", "rateprofile"] as const) {
    const indexes = [...new Set(work.filter((line) => line.item.scope.kind === kind).map((line) => (line.item.scope as { index: number }).index))].sort((a, b) => a - b);
    for (const index of indexes) {
      script.push(`${kind} ${index}`);
      emit(work.filter((line) => line.item.scope.kind === kind && (line.item.scope as { index: number }).index === index));
    }
  }

  if (needsApply) script.push("simplified_tuning apply");

  const { activeProfile, activeRateProfile } = activeSelection(input.diff);
  if (activeProfile !== undefined) script.push(`profile ${activeProfile}`);
  if (activeRateProfile !== undefined) script.push(`rateprofile ${activeRateProfile}`);

  script.push("batch end");
  return script;
}

function activeSelection(document: ConfigDocument): { activeProfile?: number; activeRateProfile?: number } {
  return { activeProfile: document.metadata.activeProfile, activeRateProfile: document.metadata.activeRateProfile };
}

function tally(items: readonly PlanItem[]): Record<Outcome, number> {
  const counts: Record<Outcome, number> = { carried: 0, renamed: 0, converted: 0, derived: 0, dropped: 0, attention: 0, "default-changed": 0, standard: 0, suggested: 0 };
  for (const item of items) counts[item.outcome]++;
  return counts;
}

/** Builds the full migration plan. Nothing here touches a board. */
export function planMigration(input: MigrationInput): MigrationPlan {
  const source = releaseLineOf(input.sourceVersion);
  const target = releaseLineOf(input.targetVersion);
  if (!source) throw new UnsupportedMigrationError(`Migrating from ${input.sourceVersion} is not supported yet.`);
  if (!target) throw new UnsupportedMigrationError(`Migrating to ${input.targetVersion} is not supported yet.`);
  if (!isBefore(source, target) && source !== target) throw new UnsupportedMigrationError("Downgrades are not supported.");

  const packs = packsBetween(source, target);
  const plan = new PlanBuilder();
  const values = indexValues(input.dump);
  let work: WorkLine[] = [];

  const crossesDChange = isBefore(source, "2025.12") && !isBefore(target, "2025.12");
  const tuning = crossesDChange ? migrateTuning45(input, values, plan, work) : { summaries: [], handled: new Set<string>(), needsApply: false };

  const commands = addCommands(input, plan);

  for (const entry of input.diff.entries) {
    if (entry.kind !== "set") continue;
    if (tuning.handled.has(`${scopeKey(entry.scope)}|${entry.name}`)) continue;
    if (crossesDChange && D_SETTINGS.test(entry.name)) continue;
    const context: RuleContext = { effective: (name) => values.get(name, entry.scope) };
    applyRules(entry, packs, context, plan, work);
  }

  work = validateAgainstTarget(work, input);
  applySuggestions(input, plan, work);
  addDefaultChanges(input, packs, values, plan, work);
  work = applyStandards(input, plan, work);

  const script = buildScript(commands, work, input, tuning.needsApply);
  const steps = packs.map((pack) => `${pack.from} to ${pack.to}`);

  return { sourceVersion: input.sourceVersion, targetVersion: input.targetVersion, steps, items: plan.items, tuning: tuning.summaries, script, counts: tally(plan.items) };
}
