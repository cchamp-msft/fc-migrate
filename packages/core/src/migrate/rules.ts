import { RELEASE_LINES, type ReleaseLine } from "./types.js";

/** Reads the effective source value of a setting while a rule runs. */
export interface RuleContext {
  effective(name: string): string | undefined;
}

export type SettingRule =
  | { kind: "rename"; from: string; to: string; note?: string }
  | {
      kind: "convert";
      from: string;
      to?: string;
      note: string;
      /** Returns the new value, or undefined when the setting should be dropped. */
      convert(value: string, context: RuleContext): string | undefined;
      dropNote?: string;
    }
  | { kind: "drop"; name: string; reason: string }
  | { kind: "attention"; name: string; reason: string };

export interface RulePack {
  from: ReleaseLine;
  to: ReleaseLine;
  rules: SettingRule[];
}

const NO_GYRO_ALIGN =
  "Gyro alignment now comes from the board definition. A custom value cannot be set on the target. If your gyro is mounted differently, compensate with align_board_* and verify the model moves correctly.";

function gyroAlignRules(): SettingRule[] {
  const rules: SettingRule[] = [];
  for (const gyro of [1, 2]) {
    for (const suffix of ["sensor_align", "align_roll", "align_pitch", "align_yaw"]) {
      rules.push({ kind: "attention", name: `gyro_${gyro}_${suffix}`, reason: NO_GYRO_ALIGN });
    }
  }
  return rules;
}

/** Removes the warning bit retired at 2025.12 and closes the gap it left. */
export function convertWarnBitmask(value: number): number {
  const low = value & 0xff;
  const high = Math.floor(value / 512);
  return low + high * 256;
}

export function convertThrustLinear(value: number): number {
  return Math.round(((-1 + Math.sqrt(1 + (4 * value) / 100)) / 2) * 100);
}

export const RULE_PACKS: readonly RulePack[] = [
  {
    from: "4.5",
    to: "2025.12",
    rules: [
      { kind: "rename", from: "simplified_dmax_gain", to: "simplified_d_max_gain" },
      { kind: "rename", from: "dshot_idle_value", to: "motor_idle" },
      {
        kind: "convert",
        from: "min_throttle",
        to: "motor_idle",
        note: "Analog minimum throttle now sets motor idle.",
        dropNote: "Only affects analog ESC protocols, and this board does not use one.",
        convert(value, context) {
          const protocol = context.effective("motor_pwm_protocol") ?? "";
          if (protocol.startsWith("DSHOT") || protocol.startsWith("PROSHOT")) return undefined;
          const minCommand = Number(context.effective("min_command") ?? 1000);
          return String((Number(value) - minCommand) * 10);
        },
      },
      {
        kind: "convert",
        from: "failsafe_off_delay",
        to: "failsafe_landing_time",
        note: "Now set in whole seconds rather than tenths of a second.",
        convert: (value) => String(Math.max(1, Math.round(Number(value) / 10))),
      },
      {
        kind: "convert",
        from: "gyro_to_use",
        to: "gyro_enabled_bitmask",
        note: "Gyro selection is now a bitmask.",
        convert: (value) => ({ FIRST: "1", SECOND: "2", BOTH: "3" })[value.toUpperCase()],
        dropNote: "Unrecognized gyro selection.",
      },
      {
        kind: "convert",
        from: "osd_warn_bitmask",
        note: "One warning was retired at 2025.12, so later warnings moved down a bit position.",
        convert: (value) => String(convertWarnBitmask(Number(value))),
      },
      ...gyroAlignRules(),
      { kind: "drop", name: "dyn_idle_start_increase", reason: "Removed. The firmware derives this from motor idle." },
      { kind: "drop", name: "iterm_limit", reason: "Removed. The I limit now derives from iterm_windup." },
      { kind: "drop", name: "crashflip_expo", reason: "Removed. crashflip_rate is a different control, so the value does not carry over." },
      { kind: "drop", name: "rc_smoothing_feedforward_cutoff", reason: "Removed. Setpoint and feedforward now share one cutoff." },
      { kind: "attention", name: "iterm_windup", reason: "Meaning changed: it now clamps I to a percentage of the PID sum limit. Your value carries, but re-check it in flight." },
      { kind: "attention", name: "feedforward_smooth_factor", reason: "Meaning changed: it is now normalized to a 250 Hz packet rate. Your value carries, but re-check it in flight." },
      { kind: "attention", name: "feedforward_jitter_factor", reason: "The jitter calculation changed. Your value carries, but re-check it in flight." },
    ],
  },
  {
    from: "2025.12",
    to: "2026.6",
    rules: [
      { kind: "drop", name: "abs_control_gain", reason: "Absolute control was removed." },
      { kind: "drop", name: "abs_control_limit", reason: "Absolute control was removed." },
      { kind: "drop", name: "abs_control_error_limit", reason: "Absolute control was removed." },
      { kind: "drop", name: "abs_control_cutoff", reason: "Absolute control was removed." },
      { kind: "drop", name: "transient_throttle_limit", reason: "Removed." },
      {
        kind: "convert",
        from: "thrust_linear",
        note: "The thrust curve changed at 2026.6. Converted with the formula published alongside the change.",
        convert: (value) => String(convertThrustLinear(Number(value))),
      },
    ],
  },
  {
    from: "2026.6",
    to: "2026.12",
    rules: [
      { kind: "drop", name: "use_integrated_yaw", reason: "Integrated yaw was removed." },
      { kind: "drop", name: "integrated_yaw_relax", reason: "Integrated yaw was removed." },
    ],
  },
];

/** Maps a firmware version such as `4.5.4` or `2026.6.2` to its release line. */
export function releaseLineOf(version: string): ReleaseLine | undefined {
  return RELEASE_LINES.find((line) => version === line || version.startsWith(`${line}.`) || version.startsWith(`${line}-`));
}

export function packsBetween(source: ReleaseLine, target: ReleaseLine): RulePack[] {
  const from = RELEASE_LINES.indexOf(source);
  const to = RELEASE_LINES.indexOf(target);
  return RULE_PACKS.filter((pack) => RELEASE_LINES.indexOf(pack.from) >= from && RELEASE_LINES.indexOf(pack.to) <= to);
}

export function isBefore(line: ReleaseLine, other: ReleaseLine): boolean {
  return RELEASE_LINES.indexOf(line) < RELEASE_LINES.indexOf(other);
}

/**
 * Carries one value through the packs, as the same setting would be migrated.
 * Returns undefined when the rules drop it.
 */
export function convertThrough(name: string, value: string, packs: readonly RulePack[], context: RuleContext): { name: string; value: string } | undefined {
  let currentName = name;
  let currentValue = value;
  for (const pack of packs) {
    for (const rule of pack.rules) {
      if (rule.kind === "rename" && rule.from === currentName) {
        currentName = rule.to;
      } else if (rule.kind === "convert" && rule.from === currentName) {
        const converted = rule.convert(currentValue, context);
        if (converted === undefined) return undefined;
        currentValue = converted;
        if (rule.to) currentName = rule.to;
      } else if (rule.kind === "drop" && rule.name === currentName) {
        return undefined;
      }
    }
  }
  return { name: currentName, value: currentValue };
}

/** Follows a setting's renames through the given packs. */
export function renameThrough(name: string, packs: readonly RulePack[]): string {
  let current = name;
  for (const pack of packs) {
    for (const rule of pack.rules) {
      if ((rule.kind === "rename" || rule.kind === "convert") && rule.from === current && rule.to) current = rule.to;
    }
  }
  return current;
}
