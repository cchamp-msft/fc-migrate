import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/document.js";
import { FcLink } from "../src/fc/link.js";
import { applyScript, compareValues, verifyApplied } from "../src/migrate/apply.js";
import { planMigration } from "../src/migrate/engine.js";
import { SimulatedFc } from "../src/testing/index.js";
import { boardProfile, capturedCli } from "./helpers.js";

const BOARD = "RRIOT_F722-4.5.4";
const diffText = capturedCli(BOARD, "diff_all");
const dumpText = capturedCli(BOARD, "dump_all");

function plan() {
  return planMigration({ sourceVersion: "4.5.4", targetVersion: "2026.6.2", diff: parseConfig(diffText), dump: parseConfig(dumpText) });
}

async function session(rejectedSettings?: string[]) {
  const fc = new SimulatedFc(boardProfile(BOARD), { rejectedSettings });
  await fc.open();
  const link = new FcLink(fc);
  await link.cli.enter();
  return { fc, cli: link.cli };
}

describe("applying a plan", () => {
  it("sends every line in order and never saves", async () => {
    const { fc, cli } = await session();
    const script = ["batch start", "defaults nosave", "set vbat_scale = 101", "batch end"];
    const result = await applyScript(cli, script);
    expect(result.failures).toEqual([]);
    const sent = fc.receivedLines.filter((line) => !line.startsWith("#") && line !== "");
    expect(sent).toEqual(script);
    expect(fc.rebootCount).toBe(0);
  });

  it("records rejected lines and keeps going", async () => {
    const { cli } = await session(["bad_setting"]);
    const result = await applyScript(cli, ["set bad_setting = 1", "set vbat_scale = 101"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.line).toBe("set bad_setting = 1");
    expect(result.failures[0]?.message).toMatch(/INVALID NAME/);
    expect(result.lines[1]?.ok).toBe(true);
  });

  it("reports progress through the script", async () => {
    const { cli } = await session();
    const seen: number[] = [];
    await applyScript(cli, ["batch start", "batch end"], (progress) => seen.push(progress.done));
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("verifying a plan", () => {
  it("passes when the board reports the planned values", () => {
    const current = plan();
    expect(verifyApplied(current, parseConfig(diffText))).toEqual([]);
  });

  it("names any value that differs", () => {
    const current = plan();
    const board = parseConfig(diffText.replace("set vbat_scale = 101", "set vbat_scale = 110"));
    expect(verifyApplied(current, board)).toEqual([{ name: "vbat_scale", scope: "master", expected: "101", actual: "110" }]);
  });

  it("names a value missing from the board", () => {
    const current = plan();
    const board = parseConfig(diffText.replace("set vbat_scale = 101\n", ""));
    expect(verifyApplied(current, board)[0]).toMatchObject({ name: "vbat_scale", actual: undefined });
  });
});

describe("comparing values", () => {
  const board = parseConfig("set dshot_bidir = ON\nprofile 1\nset throttle_boost = 0");

  it("ignores case and keeps scopes apart", () => {
    expect(compareValues([{ scope: { kind: "master" }, name: "dshot_bidir", value: "on" }], board)).toEqual([]);
    expect(compareValues([{ scope: { kind: "profile", index: 0 }, name: "throttle_boost", value: "0" }], board)).toEqual([{ name: "throttle_boost", scope: "profile:0", expected: "0", actual: undefined }]);
  });
});
