import { describe, expect, it } from "vitest";
import type { FirmwareRelease } from "../src/firmware/build-api.js";
import { compareVersions, upgradeTargets } from "../src/firmware/versions.js";

const release = (name: string, type = "Stable"): FirmwareRelease => ({ release: name, label: "", type });

/** The list build.betaflight.com returned for RRIOT_F722, newest first. */
const RELEASES = [release("2026.12.0-alpha", "Unstable"), release("2026.6.2"), release("2026.6.1"), release("2025.12.5"), release("4.5.5"), release("4.5.3"), release("2025.12.0-KAACK", "Unstable")];

const names = (list: readonly FirmwareRelease[]) => list.map((entry) => entry.release);

describe("compareVersions", () => {
  it("compares numerically rather than as text", () => {
    expect(compareVersions("2026.12.0", "2026.6.2")).toBeGreaterThan(0);
    expect(compareVersions("4.5.10", "4.5.9")).toBeGreaterThan(0);
  });

  it("treats a pre-release as older than its final release", () => {
    expect(compareVersions("2026.12.0-alpha", "2026.12.0")).toBeLessThan(0);
    expect(compareVersions("2026.12.0-alpha", "2026.6.2")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("2026.6.1", "2026.6.1")).toBe(0);
  });
});

describe("upgradeTargets", () => {
  it("offers a newer patch on the same release line, and the release it runs", () => {
    expect(names(upgradeTargets("2026.6.1", RELEASES, false))).toEqual(["2026.6.2", "2026.6.1"]);
  });

  it("offers only a rebuild of the newest stable release", () => {
    expect(names(upgradeTargets("2026.6.2", RELEASES, false))).toEqual(["2026.6.2"]);
  });

  it("adds unstable releases only when asked, but always offers the release it runs", () => {
    expect(names(upgradeTargets("2026.6.2", RELEASES, true))).toEqual(["2026.12.0-alpha", "2026.6.2"]);
    expect(names(upgradeTargets("2026.12.0-alpha", RELEASES, false))).toEqual(["2026.12.0-alpha"]);
  });

  it("offers every newer release to an older board, newest first", () => {
    expect(names(upgradeTargets("4.5.4", RELEASES, false))).toEqual(["2026.6.2", "2026.6.1", "2025.12.5", "4.5.5"]);
  });

  it("never offers an older release", () => {
    expect(names(upgradeTargets("2026.6.1", RELEASES, true))).not.toContain("2025.12.5");
  });

  it("leaves out release lines migration does not know", () => {
    expect(upgradeTargets("4.5.4", [release("2027.1.0")], false)).toEqual([]);
  });
});
