import type { SettingSchema } from "./types.js";

export type ValueProblem = { ok: true } | { ok: false; reason: string };

const ok: ValueProblem = { ok: true };

/** Checks a value against a setting's schema the way the firmware CLI would. */
export function validateValue(setting: SettingSchema, value: string): ValueProblem {
  switch (setting.kind) {
    case "number": {
      if (!/^-?\d+$/.test(value)) return { ok: false, reason: `"${value}" is not a whole number` };
      const number = Number(value);
      return number >= setting.min && number <= setting.max ? ok : { ok: false, reason: `${value} is outside ${setting.min} to ${setting.max}` };
    }
    case "enum": {
      const match = setting.values.some((candidate) => candidate.toUpperCase() === value.toUpperCase());
      return match ? ok : { ok: false, reason: `"${value}" is not one of ${setting.values.join(", ")}` };
    }
    case "array": {
      const count = value.split(",").length;
      return count === setting.length ? ok : { ok: false, reason: `expected ${setting.length} values, got ${count}` };
    }
    case "string":
      return value.length <= setting.maxLength ? ok : { ok: false, reason: `longer than ${setting.maxLength} characters` };
  }
}
