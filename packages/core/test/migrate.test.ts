import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/document.js";
import { planMigration, UnsupportedMigrationError } from "../src/migrate/engine.js";
import { convertThrustLinear, convertWarnBitmask, packsBetween, releaseLineOf, renameThrough } from "../src/migrate/rules.js";
import { BASE_45, convertD, convertDMaxAdvance, fitSliders, matchesSliders, pidsFromSliders45, type PidSet, type Sliders } from "../src/migrate/tuning.js";
import type { MigrationInput, PlanItem } from "../src/migrate/types.js";
import { parseGetOutput } from "../src/schema/from-cli.js";
import type { FirmwareSchema } from "../src/schema/types.js";
import { capturedCli } from "./helpers.js";

const BOARD = "RRIOT_F722-4.5.4";
const diffText = capturedCli(BOARD, "diff_all");
const dumpText = capturedCli(BOARD, "dump_all");
const sourceSettings = parseGetOutput(capturedCli(BOARD, "get_all"));

const DEFAULT_SLIDERS: Sliders = { master: 100, i: 100, d: 100, pi: 100, dMax: 100, feedforward: 100, pitchD: 100, pitchPi: 100 };

function input(overrides: Partial<MigrationInput> = {}): MigrationInput {
  return { sourceVersion: "4.5.4", targetVersion: "2026.6.2", diff: parseConfig(diffText), dump: parseConfig(dumpText), ...overrides };
}

function byName(items: readonly PlanItem[], name: string): PlanItem | undefined {
  return items.find((item) => item.sourceName === name);
}

/** A schema with every source setting, the way a target that changed nothing would look. */
function targetSchema(edit?: (settings: FirmwareSchema["settings"]) => void): FirmwareSchema {
  const settings = structuredClone(sourceSettings);
  edit?.(settings);
  return { firmwareVersion: "2026.6.2", source: "live-board", settings, commands: {} };
}

describe("target schema coverage", () => {
  const captured = (from: string): FirmwareSchema => ({ ...targetSchema((settings) => delete settings.small_angle), capturedFrom: from });

  it("drops a missing setting when the schema came from this board", () => {
    const plan = planMigration(input({ boardName: "RRIOT_F722", targetSchema: captured("RRIOT_F722"), diff: parseConfig("set small_angle = 180") }));
    expect(byName(plan.items, "small_angle")?.outcome).toBe("dropped");
  });

  it("sends a missing setting when the schema came from another board", () => {
    const plan = planMigration(input({ boardName: "SPEEDYBEEF405V4", targetSchema: captured("RRIOT_F722"), diff: parseConfig("set small_angle = 180") }));
    expect(byName(plan.items, "small_angle")?.outcome).toBe("carried");
    expect(plan.script).toContain("set small_angle = 180");
  });
});

describe("patch upgrades within a release line", () => {
  it("replays the configuration with no conversions", () => {
    const plan = planMigration(input({ sourceVersion: "2026.6.1", targetVersion: "2026.6.2", diff: parseConfig("set small_angle = 180\nset d_roll = 40") }));
    expect(plan.steps).toEqual([]);
    expect(plan.counts.carried).toBe(2);
    expect(plan.script).toEqual(["batch start", "defaults nosave", "set small_angle = 180", "set d_roll = 40", "batch end"]);
  });
});

describe("version handling", () => {
  it("maps versions to release lines", () => {
    expect(releaseLineOf("4.5.4")).toBe("4.5");
    expect(releaseLineOf("2025.12.5")).toBe("2025.12");
    expect(releaseLineOf("2026.6.2")).toBe("2026.6");
    expect(releaseLineOf("2026.12.0-alpha")).toBe("2026.12");
    expect(releaseLineOf("4.4.3")).toBeUndefined();
  });

  it("chains rule packs between versions", () => {
    expect(packsBetween("4.5", "2026.6").map((pack) => pack.to)).toEqual(["2025.12", "2026.6"]);
  });

  it("follows renames through the chain", () => {
    expect(renameThrough("dshot_idle_value", packsBetween("4.5", "2026.6"))).toBe("motor_idle");
  });

  it("refuses unsupported migrations", () => {
    expect(() => planMigration(input({ sourceVersion: "4.3.2" }))).toThrow(UnsupportedMigrationError);
    expect(() => planMigration(input({ sourceVersion: "2026.6.2", targetVersion: "2025.12.5" }))).toThrow(UnsupportedMigrationError);
  });
});

describe("value conversions from the firmware changes", () => {
  it("removes the retired warning bit", () => {
    expect(convertWarnBitmask(0b1111_1111)).toBe(0b1111_1111);
    expect(convertWarnBitmask(1 << 8)).toBe(0);
    expect(convertWarnBitmask(1 << 9)).toBe(1 << 8);
    expect(convertWarnBitmask(1 << 18)).toBe(1 << 17);
  });

  it("matches the published thrust examples", () => {
    expect(convertThrustLinear(100)).toBe(62);
    expect(convertThrustLinear(50)).toBe(37);
    expect(convertThrustLinear(30)).toBe(24);
  });
});

describe("D meaning change", () => {
  it("turns base and peak around when boost was active", () => {
    expect(convertD(40, 30)).toEqual({ d: 30, dMax: 40 });
  });

  it("switches boost off explicitly when it was off", () => {
    expect(convertD(40, 0)).toEqual({ d: 40, dMax: 0 });
    expect(convertD(30, 40)).toEqual({ d: 30, dMax: 0 });
  });

  it("multiplies advance through by gain", () => {
    expect(convertDMaxAdvance(37, 20)).toBe(7);
  });
});

describe("slider model", () => {
  it("reproduces the 4.5 factory PIDs at default sliders", () => {
    expect(pidsFromSliders45(DEFAULT_SLIDERS, ["roll", "pitch", "yaw"])).toEqual(BASE_45);
  });

  it("gives the same D on 4.5 and on the new firmware's formula", () => {
    for (const dMax of [0, 50, 100, 150]) {
      const sliders = { ...DEFAULT_SLIDERS, dMax, d: 120, master: 90 };
      const old = pidsFromSliders45(sliders, ["roll"]).roll!;
      const k = 0.9 * 1.2;
      const newBase = Math.trunc(30 * k);
      const s = dMax / 100;
      const newPeak = Math.trunc(40 * k * (s + ((1 - s) * 30) / 40));
      expect(convertD(old.d, old.dMin).d).toBe(newBase);
      if (old.dMin < old.d) expect(convertD(old.d, old.dMin).dMax).toBe(newPeak);
    }
  });

  it("recognises a tune that the sliders explain", () => {
    expect(matchesSliders(BASE_45, DEFAULT_SLIDERS, ["roll", "pitch", "yaw"])).toBe(true);
  });

  it("recognises a tune that the sliders do not explain", () => {
    const custom: PidSet = structuredClone(BASE_45);
    custom.roll.p = 70;
    expect(matchesSliders(custom, DEFAULT_SLIDERS, ["roll", "pitch", "yaw"])).toBe(false);
  });

  it("fits sliders to a tune and reports the error", () => {
    const actual = pidsFromSliders45({ ...DEFAULT_SLIDERS, pi: 120, d: 110, feedforward: 80 }, ["roll", "pitch", "yaw"]) as PidSet;
    const fit = fitSliders(actual);
    expect(fit.sliders.simplified_pi_gain).toBe(120);
    expect(fit.sliders.simplified_d_gain).toBe(110);
    expect(fit.sliders.simplified_feedforward_gain).toBe(80);
    expect(fit.maxError).toBeLessThanOrEqual(1);
  });
});

describe("planning the real board", () => {
  const plan = planMigration(input());

  it("records the steps taken", () => {
    expect(plan.steps).toEqual(["4.5 to 2025.12", "2025.12 to 2026.6"]);
  });

  it("carries wiring, modes, and the VTX table", () => {
    expect(plan.script).toContain("serial 0 64 115200 57600 0 115200");
    expect(plan.script).toContain("aux 1 13 3 1700 2100 0 0");
    expect(plan.script).toContain("vtxtable powerlevels 5");
    expect(plan.script).toContain("feature OSD");
  });

  it("keeps OSD positions and identity", () => {
    expect(plan.script).toContain("set osd_warnings_pos = 14569");
    expect(plan.script).toContain("board_name RRIOT_F722");
    expect(plan.script.some((line) => line.startsWith("mcu_id"))).toBe(false);
  });

  it("puts profile settings under their profile", () => {
    const profile = plan.script.indexOf("profile 0");
    const boost = plan.script.indexOf("set throttle_boost = 0");
    expect(profile).toBeGreaterThan(-1);
    expect(boost).toBeGreaterThan(profile);
  });

  it("restores the active rate profile", () => {
    expect(plan.script.lastIndexOf("rateprofile 1")).toBeGreaterThan(plan.script.indexOf("set roll_expo = 34"));
  });

  it("wraps the script in a batch and leaves saving to the caller", () => {
    expect(plan.script.slice(0, 2)).toEqual(["batch start", "defaults nosave"]);
    expect(plan.script[plan.script.length - 1]).toBe("batch end");
    expect(plan.script).not.toContain("save");
  });

  it("identifies the default tune as slider owned", () => {
    expect(plan.tuning).toHaveLength(4);
    expect(plan.tuning.every((profile) => profile.mode === "sliders")).toBe(true);
  });
});

describe("rules on a modified config", () => {
  const withLines = (...lines: string[]) => parseConfig(`${diffText}\n${lines.join("\n")}`);

  it("renames and converts settings", () => {
    const plan = planMigration(input({ diff: withLines("set dshot_idle_value = 450", "set failsafe_off_delay = 50") }));
    expect(byName(plan.items, "dshot_idle_value")).toMatchObject({ outcome: "renamed", targetName: "motor_idle" });
    expect(plan.script).toContain("set motor_idle = 450");
    expect(plan.script).toContain("set failsafe_landing_time = 5");
  });

  it("drops min_throttle on digital protocols with the reason", () => {
    const plan = planMigration(input({ diff: withLines("set min_throttle = 1050") }));
    expect(byName(plan.items, "min_throttle")?.outcome).toBe("dropped");
    expect(plan.script.join("\n")).not.toContain("min_throttle");
  });

  it("flags a custom gyro alignment and does not send it", () => {
    const plan = planMigration(input({ diff: withLines("set gyro_1_sensor_align = CW90") }));
    expect(byName(plan.items, "gyro_1_sensor_align")?.outcome).toBe("attention");
    expect(plan.script.join("\n")).not.toContain("gyro_1_sensor_align");
  });

  it("converts thrust linearization only when crossing 2026.6", () => {
    const diff = parseConfig(`${diffText}\nprofile 0\nset thrust_linear = 100\nprofile 0`);
    expect(planMigration(input({ diff })).script).toContain("set thrust_linear = 62");
    expect(planMigration(input({ diff, targetVersion: "2025.12.5" })).script).toContain("set thrust_linear = 100");
  });

  it("flags settings whose meaning changed but still carries them", () => {
    const diff = parseConfig(`${diffText}\nprofile 0\nset iterm_windup = 70\nprofile 0`);
    const plan = planMigration(input({ diff }));
    expect(byName(plan.items, "iterm_windup")?.outcome).toBe("attention");
    expect(plan.script).toContain("set iterm_windup = 70");
  });

  it("converts custom PIDs and keeps them authoritative", () => {
    const diff = parseConfig(`${diffText}\nprofile 0\nset p_roll = 70\nset d_roll = 50\nset d_min_roll = 35\nprofile 0`);
    const dump = parseConfig(dumpText.replace("set p_roll = 45", "set p_roll = 70").replace("set d_roll = 40", "set d_roll = 50").replace("set d_min_roll = 30", "set d_min_roll = 35"));
    const plan = planMigration(input({ diff, dump }));
    expect(plan.tuning[0]?.mode).toBe("custom");
    expect(plan.script).toContain("set d_roll = 35");
    expect(plan.script).toContain("set d_max_roll = 50");
    expect(plan.script).toContain("set p_roll = 70");
    expect(plan.script).toContain("set simplified_pids_mode = OFF");
  });

  it("carries changed sliders and asks the firmware to apply them", () => {
    const dump = parseConfig(dumpText.replace("set simplified_d_gain = 100", "set simplified_d_gain = 120").replace("set d_roll = 40", "set d_roll = 48").replace("set d_min_roll = 30", "set d_min_roll = 36").replace("set d_pitch = 46", "set d_pitch = 55").replace("set d_min_pitch = 34", "set d_min_pitch = 40"));
    const diff = parseConfig(`${diffText}\nprofile 0\nset simplified_d_gain = 120\nset simplified_dmax_gain = 100\nset d_roll = 48\nset d_min_roll = 36\nprofile 0`);
    const plan = planMigration(input({ diff, dump }));
    expect(plan.tuning[0]?.mode).toBe("sliders");
    expect(plan.script).toContain("set simplified_d_gain = 120");
    expect(plan.script).toContain("set simplified_d_max_gain = 100");
    expect(plan.script).toContain("simplified_tuning apply");
    expect(plan.script.join("\n")).not.toContain("set d_roll");
    expect(byName(plan.items, "d_roll")?.outcome).toBe("derived");
  });
});

describe("validation against the target", () => {
  it("drops fork-only settings with an explanation", () => {
    const diff = parseConfig(`${diffText}\nset extra_armed_warning = LETS GO`);
    const schema = targetSchema((settings) => delete settings.extra_armed_warning);
    const plan = planMigration(input({ diff, targetSchema: schema }));
    expect(byName(plan.items, "extra_armed_warning")).toMatchObject({ outcome: "dropped", note: expect.stringContaining("fork") });
  });

  it("holds back values the target would reject", () => {
    const schema = targetSchema((settings) => {
      const scale = settings.vbat_scale!;
      if (scale.kind === "number") scale.max = 50;
    });
    const plan = planMigration(input({ targetSchema: schema }));
    expect(byName(plan.items, "vbat_scale")?.outcome).toBe("attention");
    expect(plan.script.join("\n")).not.toContain("set vbat_scale");
  });
});

describe("accepted suggestions", () => {
  /** A target where `from` was renamed to `to`, so lines using `from` cannot be sent. */
  const renamed = (from: string, to: string) =>
    targetSchema((settings) => {
      settings[to] = { ...settings[from]!, name: to };
      delete settings[from];
    });

  it("marks lines that will not be sent as repairable", () => {
    const plan = planMigration(input({ targetSchema: renamed("small_angle", "tilt_limit"), diff: parseConfig("set small_angle = 25") }));
    expect(byName(plan.items, "small_angle")).toMatchObject({ outcome: "dropped", failedLine: "set small_angle = 25" });
  });

  it("sends a replacement the pilot accepted", () => {
    const suggestions = new Map([["set small_angle = 25", "set tilt_limit = 25"]]);
    const plan = planMigration(input({ targetSchema: renamed("small_angle", "tilt_limit"), diff: parseConfig("set small_angle = 25"), suggestions }));
    expect(byName(plan.items, "small_angle")).toMatchObject({ outcome: "suggested", targetName: "tilt_limit", targetValue: "25", line: "set tilt_limit = 25" });
    expect(plan.counts.suggested).toBe(1);
  });

  it("ignores a replacement the target would reject, and says why", () => {
    const schema = renamed("small_angle", "tilt_limit");
    for (const replacement of ["set tilt_limit = 999", "set no_such_setting = 1", "tilt_limit 25"]) {
      const plan = planMigration(input({ targetSchema: schema, diff: parseConfig("set small_angle = 25"), suggestions: new Map([["set small_angle = 25", replacement]]) }));
      expect(byName(plan.items, "small_angle")).toMatchObject({ outcome: "dropped", suggestionProblem: expect.any(String) });
      expect(plan.script.join("\n")).not.toContain("tilt_limit");
    }
  });

  it("never overrides a setting the plan already sends", () => {
    const suggestions = new Map([["set small_angle = 25", "set tilt_limit = 25"]]);
    const plan = planMigration(input({ targetSchema: renamed("small_angle", "tilt_limit"), diff: parseConfig("set tilt_limit = 30\nset small_angle = 25"), suggestions }));
    expect(byName(plan.items, "small_angle")).toMatchObject({ outcome: "dropped", suggestionProblem: expect.stringContaining("already set") });
    expect(plan.script.filter((line) => line.startsWith("set tilt_limit"))).toEqual(["set tilt_limit = 30"]);
  });

  it("lets a pilot standard win over a replacement", () => {
    const suggestions = new Map([["set small_angle = 25", "set tilt_limit = 25"]]);
    const plan = planMigration(input({ targetSchema: renamed("small_angle", "tilt_limit"), diff: parseConfig("set small_angle = 25"), suggestions, standards: [{ name: "tilt_limit", value: "40" }] }));
    expect(byName(plan.items, "small_angle")).toMatchObject({ outcome: "dropped", suggestionProblem: expect.stringContaining("standard") });
    expect(plan.script.filter((line) => line.startsWith("set tilt_limit"))).toEqual(["set tilt_limit = 40"]);
  });

  it("keeps a profile line in its own profile", () => {
    const suggestions = new Map([["set throttle_boost = 5", "set boost = 5"]]);
    const diff = parseConfig("profile 1\nset throttle_boost = 5");
    const plan = planMigration(input({ targetSchema: renamed("throttle_boost", "boost"), diff, suggestions }));
    const script = plan.script.join("\n");
    expect(script).toContain("profile 1\nset boost = 5");
  });

  it("refuses to move a line to another section", () => {
    const toProfile = new Map([["set small_angle = 25", "set throttle_boost = 5"]]);
    const plan = planMigration(input({ targetSchema: renamed("small_angle", "tilt_limit"), diff: parseConfig("set small_angle = 25"), suggestions: toProfile }));
    expect(byName(plan.items, "small_angle")).toMatchObject({ outcome: "dropped", suggestionProblem: expect.stringContaining("PID profile") });

    const toMaster = new Map([["set throttle_boost = 5", "set small_angle = 5"]]);
    const fromProfile = planMigration(input({ targetSchema: renamed("throttle_boost", "boost"), diff: parseConfig("profile 1\nset throttle_boost = 5"), suggestions: toMaster }));
    expect(byName(fromProfile.items, "throttle_boost")?.outcome).toBe("dropped");
    expect(fromProfile.script.join("\n")).not.toContain("small_angle");
  });

  it("does not offer gyro alignment or lines that are still sent", () => {
    const plan = planMigration(input({ diff: parseConfig("set gyro_1_sensor_align = CW90\nset small_angle = 25") }));
    expect(byName(plan.items, "gyro_1_sensor_align")?.failedLine).toBeUndefined();
    expect(byName(plan.items, "small_angle")?.failedLine).toBeUndefined();
  });
});

describe("defaults and pilot standards", () => {
  const sourceSchema: FirmwareSchema = { firmwareVersion: "4.5.4", source: "live-board", settings: sourceSettings, commands: {} };

  it("lists changed defaults without sending them", () => {
    const schema = targetSchema((settings) => {
      settings.feedforward_averaging!.defaultValue = "2_POINT";
    });
    const plan = planMigration(input({ sourceSchema, targetSchema: schema }));
    expect(byName(plan.items, "feedforward_averaging")).toMatchObject({ outcome: "default-changed", targetValue: "2_POINT" });
    expect(plan.script.join("\n")).not.toContain("feedforward_averaging");
  });

  it("compares a rescaled default in the target's units", () => {
    const schema = targetSchema((settings) => {
      settings.failsafe_landing_time = { name: "failsafe_landing_time", scope: "master", kind: "number", min: 1, max: 250, defaultValue: "60" };
      delete settings.failsafe_off_delay;
    });
    const plan = planMigration(input({ sourceSchema, targetSchema: schema }));
    expect(byName(plan.items, "failsafe_off_delay")).toMatchObject({ outcome: "default-changed", sourceValue: "1", targetName: "failsafe_landing_time", targetValue: "60" });
  });

  it("does not report a default the rules drop on this board", () => {
    const schema = targetSchema((settings) => {
      settings.motor_idle = { name: "motor_idle", scope: "master", kind: "number", min: 0, max: 2000, defaultValue: "550" };
      delete settings.min_throttle;
    });
    const plan = planMigration(input({ sourceSchema, targetSchema: schema }));
    expect(byName(plan.items, "min_throttle")).toBeUndefined();
  });

  it("keeps an old default when the pilot asks", () => {
    const schema = targetSchema((settings) => {
      settings.feedforward_averaging!.defaultValue = "2_POINT";
    });
    const first = planMigration(input({ sourceSchema, targetSchema: schema }));
    const id = byName(first.items, "feedforward_averaging")!.id;
    const plan = planMigration(input({ sourceSchema, targetSchema: schema, keepOldDefaults: new Set([id]) }));
    expect(plan.script).toContain("set feedforward_averaging = OFF");
  });

  it("applies a pilot standard to every profile, overriding the config", () => {
    const diff = parseConfig(`${diffText}\nprofile 1\nset throttle_boost = 9\nprofile 0`);
    const plan = planMigration(input({ diff, targetSchema: targetSchema(), standards: [{ name: "throttle_boost", value: "0" }] }));
    const lines = plan.script.filter((line) => line.startsWith("set throttle_boost"));
    expect(new Set(lines)).toEqual(new Set(["set throttle_boost = 0"]));
    expect(lines).toHaveLength(4);
    expect(plan.counts.standard).toBe(4);
  });

  it("reports a standard the target cannot honour", () => {
    const plan = planMigration(input({ targetSchema: targetSchema(), standards: [{ name: "not_real", value: "1" }] }));
    expect(byName(plan.items, "not_real")?.outcome).toBe("attention");
  });
});
