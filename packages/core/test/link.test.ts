import { describe, expect, it } from "vitest";
import { FcLink, FcRebootingError } from "../src/fc/link.js";
import { SimulatedFc } from "../src/testing/index.js";
import { boardProfile, capturedCli } from "./helpers.js";

const BOARD = "RRIOT_F722-4.5.4";

async function connected(options?: { startInCli?: boolean }) {
  const fc = new SimulatedFc(boardProfile(BOARD), options);
  await fc.open();
  return { fc, link: new FcLink(fc) };
}

describe("flight controller identity", () => {
  it("decodes the identity of the captured board", async () => {
    const { link } = await connected();
    const identity = await link.identify();

    expect(identity.variant).toBe("BTFL");
    expect(identity.firmwareVersion).toBe("4.5.4");
    expect(identity.api).toEqual({ protocol: 0, major: 1, minor: 46 });
    expect(identity.board.boardName).toBe("RRIOT_F722");
    expect(identity.board.manufacturerId).toBe("EASP");
    expect(identity.board.targetName).toBe("STM32F7X2");
    expect(identity.build.date).toBe("May 10 2026");
    expect(identity.build.gitRevision).toBe("norevis");
    expect(identity.buildKey).toBeUndefined();
    expect(identity.craftName).toBe("RRIOT SHORTY");
  });

  it("reads build options on firmware without a build key", async () => {
    const { link } = await connected();
    const identity = await link.identify();
    const defines = identity.buildOptions.map((entry) => entry.option?.define);

    expect(identity.buildOptionsKnown).toBe(true);
    expect(identity.buildOptions).toHaveLength(22);
    expect(defines).toContain("USE_SERIALRX_CRSF");
    expect(defines).toContain("USE_DSHOT");
    expect(defines).toContain("USE_VTX");
    expect(defines).not.toContain(undefined);
  });

  it("reboots a board that was left in CLI mode", async () => {
    const { fc, link } = await connected({ startInCli: true });
    await expect(link.identify()).rejects.toBeInstanceOf(FcRebootingError);
    expect(fc.rebootCount).toBe(1);
  });
});

describe("CLI session", () => {
  it("returns command output without echo, sentinel or prompt", async () => {
    const { link } = await connected();
    await link.cli.enter();
    const result = await link.cli.run("version");
    expect(result.output).toBe(capturedCli(BOARD, "version"));
    expect(result.errors).toEqual([]);
  });

  it("reports firmware errors", async () => {
    const { link } = await connected();
    await link.cli.enter();
    const result = await link.cli.run("not_a_command");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/UNKNOWN COMMAND/);
  });

  it("reads a full configuration snapshot", async () => {
    const { link } = await connected();
    const snapshot = await link.readSnapshot();
    expect(snapshot.diffAll).toBe(capturedCli(BOARD, "diff_all"));
    expect(snapshot.dumpAll).toBe(capturedCli(BOARD, "dump_all"));
    expect(snapshot.get.length).toBeGreaterThan(30_000);
  });

  it("hides quiet commands from the terminal", async () => {
    const { link } = await connected();
    await link.cli.enter();
    const seen: string[] = [];
    link.cli.onOutput((text) => seen.push(text));
    await link.cli.runQuietly("version");
    expect(seen).toEqual([]);
    await link.cli.run("version");
    expect(seen.join("")).toContain("Betaflight");
  });

  it("never shows the completion sentinel in the terminal", async () => {
    const { link } = await connected();
    await link.cli.enter();
    const seen: string[] = [];
    link.cli.onOutput((text) => seen.push(text));
    await link.cli.run("version");
    expect(seen.join("")).not.toContain("~bfm");
    expect(seen.join("")).toMatch(/^# version\n/);
  });
});
