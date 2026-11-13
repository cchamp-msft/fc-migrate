import { describe, expect, it } from "vitest";
import {
  dfuExitFrame,
  enterSwdFrame,
  exitDebugFrame,
  formatFirmware,
  isDebugPortStatus,
  isWaitStatus,
  lastRwStatusFrame,
  parseDebugRegRead,
  parseIdcodes,
  parseRwStatus,
  parseTargetVoltage,
  parseVersion,
  readDebugRegFrame,
  readIdcodesFrame,
  readMem32Frame,
  swdClockFor,
  swdClockFrame,
  targetVoltageFrame,
  versionFrame,
  writeDebugRegFrame,
  writeMem32Frame,
} from "../src/stlink/frames.js";
import { stlinkModelFor } from "../src/stlink/models.js";

function bytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  return Uint8Array.from({ length: clean.length / 2 }, (_, index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16));
}

/** A 16-byte command block: the given bytes, zero padded. */
function block(hex: string): Uint8Array {
  const result = new Uint8Array(16);
  result.set(bytes(hex));
  return result;
}

describe("ST-Link command blocks", () => {
  it("are always 16 bytes, zero padded", () => {
    for (const frame of [versionFrame(), enterSwdFrame(), readMem32Frame(0x08000000, 1024), writeDebugRegFrame(0xe000edf0, 0xa05f0003)]) {
      expect(frame).toHaveLength(16);
    }
  });

  it("encode the commands the session sends", () => {
    expect(versionFrame()).toEqual(block("f1"));
    expect(targetVoltageFrame()).toEqual(block("f7"));
    expect(dfuExitFrame()).toEqual(block("f3 07"));
    expect(enterSwdFrame()).toEqual(block("f2 30 a3"));
    expect(exitDebugFrame()).toEqual(block("f2 21"));
    expect(readIdcodesFrame()).toEqual(block("f2 31"));
    expect(lastRwStatusFrame()).toEqual(block("f2 3e"));
    expect(swdClockFrame(7)).toEqual(block("f2 43 07 00"));
    expect(swdClockFrame(798)).toEqual(block("f2 43 1e 03"));
  });

  it("put addresses, lengths and values little-endian", () => {
    expect(readMem32Frame(0x08000000, 1024)).toEqual(block("f2 07 00 00 00 08 00 04"));
    expect(writeMem32Frame(0x20000010, 8)).toEqual(block("f2 08 10 00 00 20 08 00"));
    expect(writeDebugRegFrame(0x40022008, 0x45670123)).toEqual(block("f2 35 08 20 02 40 23 01 67 45"));
    expect(writeDebugRegFrame(0xe000edf0, 0xa05f0003)).toEqual(block("f2 35 f0 ed 00 e0 03 00 5f a0"));
    expect(readDebugRegFrame(0xe0042000)).toEqual(block("f2 36 00 20 04 e0"));
  });
});

describe("ST-Link replies", () => {
  it("decode the owner's V2 clone version, V2J39S7", () => {
    const version = parseVersion(bytes("29 c7 83 04 48 37"));
    expect(version).toEqual({ stlink: 2, jtag: 39, swim: 7, msd: 0, vendorId: 0x0483, productId: 0x3748 });
    expect(formatFirmware(version)).toBe("V2J39S7");
  });

  it("read the low field as the mass-storage version on a V2-1", () => {
    const version = parseVersion(bytes("29 db 83 04 4b 37"));
    expect(version).toMatchObject({ stlink: 2, jtag: 39, swim: 0, msd: 27, productId: 0x374b });
    expect(formatFirmware(version)).toBe("V2J39M27");
  });

  it("reject a short version reply", () => {
    expect(() => parseVersion(bytes("29 c7"))).toThrow(RangeError);
  });

  it("compute the target voltage from the two ADC words", () => {
    expect(parseTargetVoltage(bytes("40 06 00 00 84 08 00 00"))).toBe(3.27);
    expect(parseTargetVoltage(bytes("00 00 00 00 84 08 00 00"))).toBeUndefined();
  });

  it("split status and value words", () => {
    expect(parseIdcodes(bytes("80 00 00 00 77 14 a0 2b 00 00 00 00"))).toEqual({ status: 0x80, idcode: 0x2ba01477 });
    expect(parseDebugRegRead(bytes("80 00 00 00 69 04 01 20"))).toEqual({ status: 0x80, value: 0x20010469 });
    expect(parseRwStatus(bytes("11 00 00 00 00 00 00 08 00 00 00 00"))).toEqual({ status: 0x11, faultAddress: 0x08000000 });
  });

  it("classify WAIT and debug-port statuses", () => {
    expect(isWaitStatus(0x10)).toBe(true);
    expect(isWaitStatus(0x14)).toBe(true);
    expect(isWaitStatus(0x11)).toBe(false);
    expect(isDebugPortStatus(0x16)).toBe(true);
    expect(isDebugPortStatus(0x09)).toBe(true);
    expect(isDebugPortStatus(0x11)).toBe(false);
    expect(isDebugPortStatus(0x81)).toBe(false);
  });
});

describe("SWD clock", () => {
  it("picks the fastest rate at or below the request", () => {
    expect(swdClockFor(480)).toEqual({ khz: 480, divisor: 7 });
    expect(swdClockFor(500)).toEqual({ khz: 480, divisor: 7 });
    expect(swdClockFor(1800)).toEqual({ khz: 1800, divisor: 1 });
    expect(swdClockFor(100_000)).toEqual({ khz: 4000, divisor: 0 });
    expect(swdClockFor(1)).toEqual({ khz: 5, divisor: 798 });
  });
});

describe("ST-Link models", () => {
  it("map product IDs to endpoints", () => {
    expect(stlinkModelFor(0x0483, 0x3748)).toMatchObject({ name: "ST-Link/V2", outEndpoint: 2, inEndpoint: 1, maxTransfer: 1024 });
    expect(stlinkModelFor(0x0483, 0x374b)).toMatchObject({ name: "ST-Link/V2-1", outEndpoint: 1, inEndpoint: 1 });
    expect(stlinkModelFor(0x0483, 0x3752)).toMatchObject({ name: "ST-Link/V2-1", outEndpoint: 1, inEndpoint: 1 });
    expect(stlinkModelFor(0x0483, 0x374e)).toBeUndefined();
    expect(stlinkModelFor(0x1234, 0x3748)).toBeUndefined();
  });
});
