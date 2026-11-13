export type SettingScope = "master" | "profile" | "rateprofile" | "battery_profile";

interface SettingBase {
  name: string;
  scope: SettingScope;
  /** Value on a board with factory defaults, as CLI text. */
  defaultValue: string;
}

export interface NumberSetting extends SettingBase {
  kind: "number";
  min: number;
  max: number;
}

export interface EnumSetting extends SettingBase {
  kind: "enum";
  values: string[];
}

export interface ArraySetting extends SettingBase {
  kind: "array";
  length: number;
}

export interface StringSetting extends SettingBase {
  kind: "string";
  minLength: number;
  maxLength: number;
}

export type SettingSchema = NumberSetting | EnumSetting | ArraySetting | StringSetting;

export interface CommandSchema {
  name: string;
  description: string;
  /** One entry per usage line printed by `help`. */
  usage: string[];
}

/** Where a schema came from, which determines how far it can be trusted. */
export type SchemaSource = "live-board" | "sitl" | "source-parse";

export interface FirmwareSchema {
  firmwareVersion: string;
  source: SchemaSource;
  /** Board the schema was captured from. Settings can differ between builds. */
  capturedFrom?: string;
  settings: Record<string, SettingSchema>;
  commands: Record<string, CommandSchema>;
}
