import { describe, expect, it } from "vitest";
import { complete, fuzzyScore, parseCurrentValues, type CompletionContext } from "../src/cli/complete.js";
import { schemaFromCli } from "../src/schema/from-cli.js";
import { capturedCli } from "./helpers.js";

const BOARD = "RRIOT_F722-4.5.4";
const getOutput = capturedCli(BOARD, "get_all");
const context: CompletionContext = {
  schema: schemaFromCli({ firmwareVersion: "4.5.4", source: "live-board", getOutput, helpOutput: capturedCli(BOARD, "help") }),
  currentValues: parseCurrentValues(getOutput),
  features: ["OSD", "TELEMETRY", "LED_STRIP"],
};

function at(line: string) {
  return complete(line, line.length, context);
}

describe("fuzzy matching", () => {
  it("ranks prefix above substring above scattered letters", () => {
    const prefix = fuzzyScore("gyro", "gyro_lpf1_type")!;
    const substring = fuzzyScore("lpf1", "gyro_lpf1_type")!;
    const scattered = fuzzyScore("gl1", "gyro_lpf1_type")!;
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(scattered);
  });

  it("rejects letters that are out of order", () => {
    expect(fuzzyScore("zq", "gyro_lpf1_type")).toBeUndefined();
  });
});

describe("completion", () => {
  it("suggests commands with their descriptions", () => {
    const result = at("aux");
    expect(result.suggestions[0]).toMatchObject({ insert: "aux", detail: "configure modes", kind: "command" });
  });

  it("finds settings by initials and shows range and current value", () => {
    const result = at("set vbs");
    const match = result.suggestions.find((entry) => entry.label === "vbat_scale");
    expect(match?.detail).toBe("0 to 255 · now 101");
    expect(match?.insert).toBe("vbat_scale = ");
  });

  it("offers enum values after the equals sign", () => {
    const result = at("set gyro_lpf1_type = PT");
    expect(result.suggestions.map((entry) => entry.insert)).toEqual(["PT1", "PT2", "PT3"]);
    expect(result.from).toBe("set gyro_lpf1_type = ".length);
    expect(result.problem).toBeUndefined();
  });

  it("flags values the firmware would reject before they are sent", () => {
    expect(at("set vbat_scale = 999").problem).toMatch(/outside 0 to 255/);
    expect(at("set gyro_lpf1_type = NOPE").problem).toMatch(/not one of/);
    expect(at("set vbat_scale = 200").problem).toBeUndefined();
  });

  it("flags settings that do not exist on this firmware", () => {
    expect(at("set not_a_setting = 1").problem).toMatch(/Unknown setting/);
  });

  it("shows the value hint with default and current value", () => {
    expect(at("set vbat_scale = ").hint).toBe("0 to 255 · default 110 · now 101");
  });

  it("completes features, including the disable form", () => {
    const line = "feature -TEL";
    const result = at(line);
    expect(result.suggestions[0]?.insert).toBe("TELEMETRY");
    expect(result.from).toBe("feature -".length);
  });

  it("completes diff arguments", () => {
    expect(at("diff a").suggestions[0]?.insert).toBe("all");
  });

  it("tracks the active argument of positional commands", () => {
    const result = at("aux 0 1 ");
    expect(result.usage?.args[0]).toBe("<index>");
    expect(result.usage?.active).toBe(2);
    expect(result.hint).toBe("configure modes");
  });

  it("uses the cursor position to complete a name mid-line", () => {
    const line = "set vbat_sc = 101";
    const result = complete(line, "set vbat_sc".length, context);
    expect(result.suggestions[0]?.insert).toBe("vbat_scale");
    expect(result.to).toBe("set vbat_sc".length);
  });
});
