import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRestoreScript, checkBootstrapReady, planBootstrap, type BootstrapChoices, type BootstrapInput } from "../src/bootstrap/bootstrap.js";
import { parseConfig } from "../src/config/document.js";
import { schemaFromCli } from "../src/schema/from-cli.js";
import type { FirmwareSchema } from "../src/schema/types.js";
import { capturedCli } from "./helpers.js";

const BOARD = "RRIOT_F722-4.5.4";
const dumpText = capturedCli(BOARD, "dump_all");
const schema45 = schemaFromCli({ firmwareVersion: "4.5.4", source: "live-board", getOutput: capturedCli(BOARD, "get_all"), helpOutput: capturedCli(BOARD, "help") });
const schema266 = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../data/schemas/2026.6.2.json"), "utf8")) as FirmwareSchema;

const DEFAULTS: BootstrapChoices = { size: "small", feel: "default", windResistant: false };

function input(overrides: Partial<BootstrapInput> = {}, dump = dumpText): BootstrapInput {
  return { firmwareVersion: "4.5.4", dump: parseConfig(dump), schema: schema45, ...overrides };
}

function replaced(from: string, to: string): string {
  expect(dumpText).toContain(from);
  return dumpText.replace(from, to);
}

describe("bootstrap readiness", () => {
  it("accepts the test board, which has bidirectional DShot on", () => {
    expect(checkBootstrapReady(input())).toEqual({ ready: true, problems: [] });
  });

  it("stops when bidirectional DShot is off", () => {
    const result = checkBootstrapReady(input({}, replaced("set dshot_bidir = ON", "set dshot_bidir = OFF")));
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toContain("Bidirectional DShot is off");
  });

  it("stops when the motor protocol is not DShot", () => {
    const result = checkBootstrapReady(input({}, replaced("set motor_pwm_protocol = DSHOT600", "set motor_pwm_protocol = MULTISHOT")));
    expect(result.problems[0]).toContain("MULTISHOT");
  });

  it("stops on firmware without simplified tuning or before 4.5", () => {
    const commands = { ...schema45.commands };
    delete commands.simplified_tuning;
    expect(checkBootstrapReady(input({ schema: { ...schema45, commands } })).problems[0]).toContain("simplified tuning");
    expect(checkBootstrapReady(input({ firmwareVersion: "4.4.3" })).problems[0]).toContain("starts at 4.5");
  });
});

describe("bootstrap plan", () => {
  const changeOf = (plan: ReturnType<typeof planBootstrap>, name: string, profile: number) =>
    plan.changes.find((change) => change.name === name && change.scope.kind === "profile" && change.scope.index === profile);

  it("zeroes throttle boost and sets dynamic idle on every profile", () => {
    const plan = planBootstrap(input(), DEFAULTS);
    for (const profile of [0, 1, 2, 3]) {
      expect(changeOf(plan, "throttle_boost", profile)?.to).toBe("0");
      expect(changeOf(plan, "dyn_idle_min_rpm", profile)?.to).toBe("35");
    }
    expect(changeOf(planBootstrap(input(), { ...DEFAULTS, size: "large" }), "dyn_idle_min_rpm", 2)?.to).toBe("30");
  });

  it("returns the active profile's sliders to default and recomputes from them", () => {
    const plan = planBootstrap(input(), DEFAULTS);
    expect(changeOf(plan, "simplified_pids_mode", plan.activeProfile)?.to).toBe("RPY");
    expect(changeOf(plan, "simplified_d_gain", plan.activeProfile)?.to).toBe("100");
    expect(changeOf(plan, "simplified_d_gain", (plan.activeProfile + 1) % 4)).toBeUndefined();
    expect(plan.script.slice(-3)).toEqual(["simplified_tuning apply", `profile ${plan.activeProfile}`, "batch end"]);
  });

  it("sends only values that change", () => {
    const plan = planBootstrap(input(), { ...DEFAULTS, size: "large" });
    // Profile 0 on the test board already has dynamic idle at 30, the 4 to 5 inch value.
    expect(changeOf(plan, "dyn_idle_min_rpm", 0)).toMatchObject({ from: "30", changed: false });
    expect(changeOf(plan, "dyn_idle_min_rpm", 1)).toMatchObject({ from: "0", changed: true });
    const profile0 = plan.script.slice(plan.script.indexOf("profile 0"), plan.script.indexOf("profile 1"));
    expect(profile0).not.toContain("set dyn_idle_min_rpm = 30");
    expect(plan.script).toContain("set dyn_idle_min_rpm = 30");
  });

  it("lists what the firmware recomputes beyond the values it is sent", () => {
    // Every profile on the test board uses sliders, and the gyro filter slider is on.
    const notes = planBootstrap(input(), DEFAULTS).recomputed;
    expect(notes).toHaveLength(5);
    expect(notes.filter((note) => note.includes("of PID profile") && note.includes("own slider positions"))).toHaveLength(3);
    expect(notes.at(-1)).toContain("Gyro filters");

    const customElsewhere = parseConfig(dumpText.replace(/(# profile 1[\s\S]*?)set simplified_pids_mode = RPY/, "$1set simplified_pids_mode = OFF"));
    expect(planBootstrap({ ...input(), dump: customElsewhere }, DEFAULTS).recomputed.find((note) => note.includes("PID profile 2"))).toBe("D-term filters of PID profile 2, from its own slider positions.");
  });

  it("applies the smooth feel", () => {
    const plan = planBootstrap(input(), { ...DEFAULTS, feel: "smooth" });
    expect(changeOf(plan, "simplified_d_gain", plan.activeProfile)?.to).toBe("115");
    expect(changeOf(plan, "simplified_dterm_filter_multiplier", plan.activeProfile)?.to).toBe("90");
  });

  it("carries the wind values to each release's names and scales", () => {
    const on45 = planBootstrap(input(), { ...DEFAULTS, windResistant: true });
    expect(changeOf(on45, "simplified_dmax_gain", on45.activeProfile)?.to).toBe("0");
    expect(changeOf(on45, "thrust_linear", on45.activeProfile)?.to).toBe("20");
    expect(changeOf(on45, "simplified_i_gain", on45.activeProfile)?.to).toBe("125");

    const on266 = planBootstrap(input({ firmwareVersion: "2026.6.2", schema: schema266 }), { ...DEFAULTS, windResistant: true });
    expect(changeOf(on266, "simplified_d_max_gain", on266.activeProfile)?.to).toBe("0");
    expect(changeOf(on266, "thrust_linear", on266.activeProfile)).toMatchObject({ to: "17", reason: expect.stringContaining("that is 17") });
    expect(on266.skipped).toEqual([]);
  });

  it("skips what this build cannot take", () => {
    const settings = { ...schema45.settings };
    delete settings.thrust_linear;
    const plan = planBootstrap(input({ schema: { ...schema45, settings } }), { ...DEFAULTS, windResistant: true });
    expect(plan.skipped.map((entry) => entry.name)).toEqual(["thrust_linear"]);
    expect(plan.script.join("\n")).not.toContain("thrust_linear");
  });
});

describe("restore script", () => {
  it("puts back PIDs, sliders and filters on every profile without recomputing", () => {
    const script = buildRestoreScript(parseConfig(dumpText));
    for (const profile of [0, 1, 2, 3]) expect(script).toContain(`profile ${profile}`);
    expect(script.some((line) => line.startsWith("set p_roll = "))).toBe(true);
    expect(script.some((line) => line.startsWith("set gyro_lpf1_static_hz = "))).toBe(true);
    expect(script.some((line) => line.startsWith("set simplified_pids_mode = "))).toBe(true);
    expect(script).not.toContain("simplified_tuning apply");
    expect(script.at(-1)).toBe("batch end");
  });
});
