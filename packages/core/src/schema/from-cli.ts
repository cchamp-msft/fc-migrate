import type { CommandSchema, FirmwareSchema, SchemaSource, SettingSchema, SettingScope } from "./types.js";

const SETTING_LINE = /^([a-zA-Z0-9_]+) = ?(.*)$/;
const SCOPE_LINE = /^(profile|rateprofile|battery_profile) \d+$/;
const RANGE_LINE = /^Allowed range: (-?\d+) - (-?\d+)$/;
const VALUES_LINE = /^Allowed values: (.*)$/;
const ARRAY_LINE = /^Array length: (\d+)$/;
const STRING_LINE = /^String length: (\d+) - (\d+)$/;
const DEFAULT_LINE = /^Default value: ?(.*)$/;

interface PartialSetting {
  name: string;
  value: string;
  scope: SettingScope;
  defaultValue?: string;
  range?: [number, number];
  values?: string[];
  arrayLength?: number;
  stringLength?: [number, number];
}

function finalise(partial: PartialSetting): SettingSchema | undefined {
  const base = { name: partial.name, scope: partial.scope, defaultValue: partial.defaultValue ?? partial.value };
  if (partial.values) return { ...base, kind: "enum", values: partial.values };
  if (partial.range) return { ...base, kind: "number", min: partial.range[0], max: partial.range[1] };
  if (partial.arrayLength !== undefined) return { ...base, kind: "array", length: partial.arrayLength };
  if (partial.stringLength) return { ...base, kind: "string", minLength: partial.stringLength[0], maxLength: partial.stringLength[1] };
  return undefined;
}

/**
 * Parses the output of a bare `get`.
 *
 * The firmware prints a `Default value` line only when a setting differs from its
 * default, so the current value is the default whenever that line is absent.
 */
export function parseGetOutput(text: string): Record<string, SettingSchema> {
  const settings: Record<string, SettingSchema> = {};
  let current: PartialSetting | undefined;
  let pendingScope: SettingScope = "master";

  const flush = () => {
    if (!current) return;
    const setting = finalise(current);
    if (setting) settings[setting.name] = setting;
    current = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      pendingScope = "master";
      continue;
    }

    const scope = SCOPE_LINE.exec(line);
    if (scope) {
      if (current) current.scope = scope[1] as SettingScope;
      else pendingScope = scope[1] as SettingScope;
      continue;
    }

    const range = RANGE_LINE.exec(line);
    const values = VALUES_LINE.exec(line);
    const arrayLength = ARRAY_LINE.exec(line);
    const stringLength = STRING_LINE.exec(line);
    const defaultValue = DEFAULT_LINE.exec(line);

    if (current && range) current.range = [Number(range[1]), Number(range[2])];
    else if (current && values) current.values = values[1]!.split(",").map((value) => value.trim());
    else if (current && arrayLength) current.arrayLength = Number(arrayLength[1]);
    else if (current && stringLength) current.stringLength = [Number(stringLength[1]), Number(stringLength[2])];
    else if (current && defaultValue) current.defaultValue = defaultValue[1]!.trim();
    else {
      const setting = SETTING_LINE.exec(line);
      if (setting) {
        flush();
        current = { name: setting[1]!, value: setting[2]!.trim(), scope: pendingScope };
        pendingScope = "master";
      }
    }
  }
  flush();
  return settings;
}

const HELP_COMMAND = /^([a-z0-9_]+)(?: - (.*))?$/;

/** Parses `help` output: a `name - description` line followed by indented usage lines. */
export function parseHelpOutput(text: string): Record<string, CommandSchema> {
  const commands: Record<string, CommandSchema> = {};
  let current: CommandSchema | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (/^\s/.test(rawLine)) {
      current?.usage.push(rawLine.trim());
      continue;
    }
    const match = HELP_COMMAND.exec(rawLine.trim());
    if (!match || match[1] === "help" && match[2] === undefined) continue;
    current = { name: match[1]!, description: match[2] ?? "", usage: [] };
    commands[current.name] = current;
  }
  return commands;
}

export function schemaFromCli(options: {
  firmwareVersion: string;
  source: SchemaSource;
  capturedFrom?: string;
  getOutput: string;
  helpOutput: string;
}): FirmwareSchema {
  return {
    firmwareVersion: options.firmwareVersion,
    source: options.source,
    capturedFrom: options.capturedFrom,
    settings: parseGetOutput(options.getOutput),
    commands: parseHelpOutput(options.helpOutput),
  };
}
