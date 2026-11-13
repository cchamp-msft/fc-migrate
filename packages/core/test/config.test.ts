import { describe, expect, it } from "vitest";
import { commandEntries, parseConfig, setEntries } from "../src/config/document.js";
import { parseGetOutput, parseHelpOutput } from "../src/schema/from-cli.js";
import { validateValue } from "../src/schema/validate.js";
import { capturedCli } from "./helpers.js";

const BOARD = "RRIOT_F722-4.5.4";

describe("config parsing", () => {
  const diff = parseConfig(capturedCli(BOARD, "diff_all"));

  it("reads metadata from the header comments", () => {
    expect(diff.metadata).toMatchObject({
      firmware: "Betaflight",
      firmwareVersion: "4.5.4",
      mspApi: "1.46",
      configRevision: "c2ca1b0",
      boardName: "RRIOT_F722",
      manufacturerId: "EASP",
      craftName: "RRIOT SHORTY",
    });
  });

  it("assigns settings to their profile", () => {
    const sets = setEntries(diff);
    expect(sets).toHaveLength(42 + 0);
    expect(sets.find((entry) => entry.name === "vbat_scale")).toMatchObject({ value: "101", scope: { kind: "master" } });
    expect(sets.find((entry) => entry.name === "throttle_boost")).toMatchObject({ value: "0", scope: { kind: "profile", index: 0 } });
    expect(sets.find((entry) => entry.name === "roll_expo")).toMatchObject({ value: "34", scope: { kind: "rateprofile", index: 1 } });
  });

  it("keeps wiring commands and drops control commands", () => {
    expect(commandEntries(diff, "serial")).toHaveLength(2);
    expect(commandEntries(diff, "aux")).toHaveLength(3);
    expect(commandEntries(diff, "vtxtable")).toHaveLength(6);
    expect(commandEntries(diff, "feature").map((entry) => entry.args[0])).toEqual(["SERVO_TILT", "TELEMETRY", "OSD", "CHANNEL_FORWARDING"]);
    expect(commandEntries(diff, "save")).toHaveLength(0);
    expect(commandEntries(diff, "defaults")).toHaveLength(0);
  });

  it("parses a full dump", () => {
    const dump = parseConfig(capturedCli(BOARD, "dump_all"));
    expect(setEntries(dump).length).toBeGreaterThan(800);
    expect(commandEntries(dump, "resource").length).toBeGreaterThan(50);
  });
});

describe("schema from CLI output", () => {
  const settings = parseGetOutput(capturedCli(BOARD, "get_all"));

  it("captures every setting", () => {
    expect(Object.keys(settings).length).toBeGreaterThanOrEqual(566);
  });

  it("reads each kind of setting", () => {
    expect(settings.vbat_scale).toMatchObject({ kind: "number", min: 0, max: 255, scope: "master" });
    expect(settings.gyro_lpf1_type).toMatchObject({ kind: "enum", values: ["PT1", "BIQUAD", "PT2", "PT3"] });
    expect(settings.motor_output_reordering).toMatchObject({ kind: "array", length: 8 });
    expect(settings.craft_name).toMatchObject({ kind: "string", maxLength: 16 });
  });

  it("uses the firmware's default when a value was changed", () => {
    expect(settings.motor_output_reordering!.defaultValue).toBe("0,1,2,3,4,5,6,7");
  });

  it("treats the current value as the default otherwise", () => {
    expect(settings.gyro_lpf1_static_hz!.defaultValue).toBe("250");
  });

  it("records the profile a setting belongs to", () => {
    expect(settings.throttle_boost!.scope).toBe("profile");
    expect(settings.roll_expo!.scope).toBe("rateprofile");
  });

  it("validates values the way the firmware does", () => {
    expect(validateValue(settings.vbat_scale!, "101").ok).toBe(true);
    expect(validateValue(settings.vbat_scale!, "300").ok).toBe(false);
    expect(validateValue(settings.gyro_lpf1_type!, "pt2").ok).toBe(true);
    expect(validateValue(settings.gyro_lpf1_type!, "PT9").ok).toBe(false);
    expect(validateValue(settings.motor_output_reordering!, "1,0").ok).toBe(false);
  });
});

describe("help parsing", () => {
  const commands = parseHelpOutput(capturedCli(BOARD, "help"));

  it("reads descriptions and usage", () => {
    expect(commands.aux).toEqual({ name: "aux", description: "configure modes", usage: ["<index> <mode> <aux> <start> <end> <logic>"] });
    expect(commands.batch!.usage).toEqual(["start | end"]);
  });

  it("finds the full command list", () => {
    expect(Object.keys(commands).length).toBeGreaterThan(30);
  });
});
