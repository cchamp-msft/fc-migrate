import type { FirmwareSchema, SettingSchema } from "../schema/types.js";
import { validateValue } from "../schema/validate.js";

export type SuggestionKind = "command" | "setting" | "value" | "keyword";

export interface Suggestion {
  /** Text placed into the line when the suggestion is accepted. */
  insert: string;
  label: string;
  detail?: string;
  kind: SuggestionKind;
}

export interface UsageHint {
  /** Usage line split into arguments. */
  args: string[];
  /** Index into `args` of the argument under the cursor, if any. */
  active: number | undefined;
}

export interface CompletionResult {
  /** Range of the line replaced by an accepted suggestion. */
  from: number;
  to: number;
  suggestions: Suggestion[];
  hint?: string;
  usage?: UsageHint;
  /** Why the line would be rejected by the firmware, when that can be known. */
  problem?: string;
}

export interface CompletionContext {
  schema: FirmwareSchema;
  currentValues?: Readonly<Record<string, string>>;
  features?: readonly string[];
  beepers?: readonly string[];
}

const MAX_SUGGESTIONS = 40;

const DIFF_ARGUMENTS = ["all", "master", "profile", "rates", "hardware", "defaults", "bare", "showdefaults"];

/**
 * Scores how well `query` matches `candidate`, or returns undefined for no match.
 * Prefix matches rank first, then substrings, then in-order letters that favour
 * the start of `_` separated words, so `gl1` finds `gyro_lpf1_type`.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  if (!query) return 1;
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  const lengthPenalty = haystack.length / 100;

  if (haystack === needle) return 1000;
  if (haystack.startsWith(needle)) return 800 - lengthPenalty;

  const substring = haystack.indexOf(needle);
  if (substring >= 0) {
    const atWordStart = haystack[substring - 1] === "_";
    return (atWordStart ? 600 : 400) - substring - lengthPenalty;
  }

  let score = 100;
  let position = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, position + 1);
    if (found < 0) return undefined;
    if (found === position + 1) score += 8;
    if (found === 0 || haystack[found - 1] === "_") score += 14;
    score -= found - position - 1;
    position = found;
  }
  return score - lengthPenalty;
}

function ranked<T>(query: string, items: readonly T[], text: (item: T) => string): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, text(item));
    if (score !== undefined) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || text(a.item).localeCompare(text(b.item)));
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.item);
}

/** One-line description of what a setting accepts. */
export function describeSetting(setting: SettingSchema): string {
  switch (setting.kind) {
    case "number":
      return `${setting.min} to ${setting.max}`;
    case "enum":
      return setting.values.length <= 6 ? setting.values.join(" | ") : `${setting.values.length} options`;
    case "array":
      return `${setting.length} comma-separated values`;
    case "string":
      return `text up to ${setting.maxLength} characters`;
  }
}

function settingDetail(setting: SettingSchema, current: string | undefined): string {
  const parts = [describeSetting(setting)];
  if (current !== undefined) parts.push(`now ${current || "(empty)"}`);
  if (setting.scope !== "master") parts.push(setting.scope);
  return parts.join(" · ");
}

function suggestSettingNames(query: string, from: number, to: number, context: CompletionContext, withAssignment: boolean): CompletionResult {
  const settings = Object.values(context.schema.settings);
  return {
    from,
    to,
    suggestions: ranked(query, settings, (setting) => setting.name).map((setting) => ({
      insert: withAssignment ? `${setting.name} = ` : setting.name,
      label: setting.name,
      detail: settingDetail(setting, context.currentValues?.[setting.name]),
      kind: "setting",
    })),
  };
}

function completeSet(line: string, cursor: number, context: CompletionContext, prefix: string): CompletionResult {
  const rest = line.slice(prefix.length);
  const assignment = /^([^\s=]*)(\s*=\s*)(.*)$/.exec(rest);

  if (!assignment) {
    const name = rest.trimEnd();
    return suggestSettingNames(name, prefix.length, line.length, context, true);
  }

  const name = assignment[1]!;
  const value = assignment[3]!;
  const valueStart = prefix.length + name.length + assignment[2]!.length;

  if (cursor < valueStart) return suggestSettingNames(name, prefix.length, prefix.length + name.length, context, false);

  const setting = context.schema.settings[name.toLowerCase()];
  if (!setting) return { from: valueStart, to: line.length, suggestions: [], problem: `Unknown setting "${name}" on this firmware` };

  const hintParts = [describeSetting(setting), `default ${setting.defaultValue || "(empty)"}`];
  const current = context.currentValues?.[setting.name];
  if (current !== undefined) hintParts.push(`now ${current || "(empty)"}`);
  const hint = hintParts.join(" · ");

  const result: CompletionResult = { from: valueStart, to: line.length, suggestions: [], hint };
  if (setting.kind === "enum") {
    result.suggestions = ranked(value, setting.values, (option) => option).map((option) => ({ insert: option, label: option, kind: "value" }));
  }
  // A partly typed option is only wrong once no option can still match it.
  const stillTyping = setting.kind === "enum" && result.suggestions.length > 0;
  if (value && !stillTyping) {
    const verdict = validateValue(setting, value);
    if (!verdict.ok) result.problem = verdict.reason;
  }
  return result;
}

function completeList(query: string, from: number, to: number, items: readonly string[], kind: SuggestionKind): CompletionResult {
  return { from, to, suggestions: ranked(query, items, (item) => item).map((item) => ({ insert: item, label: item, kind })) };
}

function usageFor(usage: readonly string[], argumentIndex: number): UsageHint | undefined {
  const chosen = usage.find((line) => line.includes("<")) ?? usage[0];
  if (!chosen) return undefined;
  const args = chosen.split(/\s+/).filter(Boolean);
  return { args, active: argumentIndex < args.length ? argumentIndex : undefined };
}

/** Computes completions for a CLI line with the cursor at `cursor`. */
export function complete(line: string, cursor: number, context: CompletionContext): CompletionResult {
  const before = line.slice(0, cursor);

  const firstToken = /^\s*(\S*)$/.exec(before);
  if (firstToken) {
    const query = firstToken[1]!;
    const from = before.length - query.length;
    const commands = Object.values(context.schema.commands);
    return {
      from,
      to: line.length,
      suggestions: ranked(query, commands, (command) => command.name).map((command) => ({
        insert: command.name,
        label: command.name,
        detail: command.description,
        kind: "command",
      })),
    };
  }

  const setPrefix = /^(\s*set\s+)/i.exec(line);
  if (setPrefix) return completeSet(line, cursor, context, setPrefix[1]!);

  const command = /^\s*(\S+)\s+/.exec(line)!;
  const commandName = command[1]!.toLowerCase();
  const argumentsStart = command[0].length;
  const argumentText = before.slice(argumentsStart);
  const tokens = argumentText.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? "";
  const tokenFrom = cursor - lastToken.length;

  if (commandName === "get") return suggestSettingNames(lastToken, tokenFrom, cursor, context, false);
  if (commandName === "diff" || commandName === "dump") return completeList(lastToken, tokenFrom, cursor, DIFF_ARGUMENTS, "keyword");

  if ((commandName === "feature" || commandName === "beeper" || commandName === "beacon") && tokens.length === 1) {
    const list = commandName === "feature" ? context.features : context.beepers;
    if (list) {
      const negate = lastToken.startsWith("-");
      const query = negate ? lastToken.slice(1) : lastToken;
      const result = completeList(query, tokenFrom + (negate ? 1 : 0), cursor, list, "value");
      return { ...result, hint: "prefix with - to disable" };
    }
  }

  const schema = context.schema.commands[commandName];
  if (!schema) return { from: cursor, to: cursor, suggestions: [], problem: `Unknown command "${commandName}" on this firmware` };

  const usage = usageFor(schema.usage, tokens.length - 1);
  return { from: cursor, to: cursor, suggestions: [], hint: schema.description, usage };
}

/** Reads the current value of every setting from a bare `get`. */
export function parseCurrentValues(getOutput: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of getOutput.split(/\r?\n/)) {
    const match = /^([a-zA-Z0-9_]+) = ?(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!.trim();
  }
  return values;
}
