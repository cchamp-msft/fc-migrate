import { describe, expect, it } from "vitest";
import { ALPHA_TEXTS, activeProtections, buildBoardReport, checkAlphaImage, classifyBoard, isMigratedAlpha } from "../src/alpha/alpha.js";
import type { HexImage } from "../src/firmware/hex.js";
import type { G4Readings } from "../src/targets/stm32g4/session.js";

/** Values a stock board's protection registers hold when nothing is protected. */
const UNPROTECTED = { wrp1ar: 0xff, wrp1br: 0xff, wrp2ar: 0xff, wrp2br: 0xff, pcrop1sr: 0x7fff, pcrop1er: 0, pcrop2sr: 0x7fff, pcrop2er: 0, sec1r: 0, sec2r: 0 };

function readings(overrides: Partial<G4Readings> = {}): G4Readings {
  return { devId: 0x469, flashSizeKb: 512, uid: "0123456789ABCDEF01234567", optr: 0xfbeff800, ...UNPROTECTED, ...overrides };
}

function program(): Uint8Array {
  const head = new Uint8Array(1024).fill(0);
  const view = new DataView(head.buffer);
  view.setUint32(0, 0x20020000, true);
  view.setUint32(4, 0x08000201, true);
  return head;
}

function image(blocks: { address: number; text?: string; head?: boolean; size?: number }[]): HexImage {
  const data = blocks.map(({ address, text = "", head = false, size = 4096 }) => {
    const bytes = new Uint8Array(size).fill(0);
    if (head) bytes.set(program().subarray(0, 8));
    if (text) bytes.set(new TextEncoder().encode(text), 64);
    return { address, bytes };
  });
  return { data, bytesTotal: data.reduce((sum, block) => sum + block.bytes.length, 0) };
}

describe("classifying a G4 Alpha over SWD", () => {
  it("treats Level 1 as a locked board, as on a stock or bricked Alpha", () => {
    const result = classifyBoard(readings());
    expect(result).toMatchObject({ kind: "locked", rdp: 1, bootPinHonoured: false });
    expect(classifyBoard(readings({ optr: 0xfbeff801 })).kind).toBe("locked");
  });

  it("reports a board whose BOOT0 pin is honoured", () => {
    expect(classifyBoard(readings({ optr: 0xffeff800 })).bootPinHonoured).toBe(true);
  });

  it("finds an interrupted migration and a migrated board at Level 0", () => {
    expect(classifyBoard(readings({ optr: 0xfbeff8aa, flashHead: new Uint8Array(1024).fill(0xff) })).kind).toBe("blank");
    expect(classifyBoard(readings({ optr: 0xfbeff8aa, flashHead: program(), configMagic: 0xbe }))).toMatchObject({ kind: "programmed", hasSettings: true });
    expect(classifyBoard(readings({ optr: 0xfbeff8aa, flashHead: new Uint8Array(1024).fill(0x12) })).kind).toBe("unknown");
  });

  it("stops on another chip", () => {
    expect(classifyBoard(readings({ devId: 0x413 })).kind).toBe("wrong-chip");
    expect(classifyBoard(readings({ flashSizeKb: 128 })).kind).toBe("wrong-chip");
  });

  it("stops on protection the tested run never saw", () => {
    expect(classifyBoard(readings({ wrp1ar: 0x00050000 })).kind).toBe("protected");
    expect(classifyBoard(readings({ sec1r: 0x00010000 })).protections).toEqual(["boot lock"]);
    expect(classifyBoard(readings({ pcrop1sr: 0, pcrop1er: 0x10 })).kind).toBe("protected");
    expect(classifyBoard(readings({ optr: 0xfbeff8cc })).kind).toBe("protected");
    expect(activeProtections(readings())).toEqual([]);
  });
});

describe("checking a firmware image", () => {
  it("accepts a Betaflight build for this board", () => {
    const result = checkAlphaImage(image([{ address: 0x08000000, head: true, text: "Betaflight TMOTORG4ALPHAHD" }, { address: 0x08006000 }]));
    expect(result).toMatchObject({ ok: true, errors: [], warnings: [], boardName: "TMOTORG4ALPHAHD", coversSettings: false });
  });

  it("refuses an Alpha image, which needs the erased bootloader", () => {
    const result = checkAlphaImage(image([{ address: 0x08003800, text: "BTFL" }]));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Alpha firmware image");
  });

  it("refuses writes outside main flash and images that would not boot", () => {
    expect(checkAlphaImage(image([{ address: 0x08000000, head: true, text: "BTFL" }, { address: 0x1fff7800, size: 16 }])).errors[0]).toContain("outside the main flash");
    expect(checkAlphaImage(image([{ address: 0x08000000, text: "BTFL" }])).errors).toContain("Its first bytes are not a valid program start, so the board would not boot.");
    expect(checkAlphaImage(image([{ address: 0x08000000, head: true, text: "INAV" }])).errors).toContain("It does not look like Betaflight.");
    expect(checkAlphaImage({ data: [], bytesTotal: 0 }).ok).toBe(false);
  });

  it("warns about the generic build, other boards, and the settings area", () => {
    expect(checkAlphaImage(image([{ address: 0x08000000, head: true, text: "Betaflight STM32G474" }])).warnings[0]).toContain("generic G474");
    expect(checkAlphaImage(image([{ address: 0x08000000, head: true, text: "Betaflight SPEEDYBEEF405" }])).warnings[0]).toContain("does not name");
    expect(checkAlphaImage(image([{ address: 0x08000000, head: true, text: "BTFL TMOTORG4ALPHAHD", size: 0x5000 }])).coversSettings).toBe(true);
  });
});

describe("recognising a migrated board over USB", () => {
  const identity = (boardName: string, manufacturerId: string, variant = "BTFL") => ({ variant, board: { boardName, manufacturerId } }) as Parameters<typeof isMigratedAlpha>[0];

  it("accepts the HD board under either manufacturer ID", () => {
    expect(isMigratedAlpha(identity("TMOTORG4ALPHAHD", "COMM"))).toBe(true);
    expect(isMigratedAlpha(identity("TMOTORG4ALPHAHD", "TMTR"))).toBe(true);
  });

  it("rejects other boards, the unsupported Analog board, and other firmware", () => {
    expect(isMigratedAlpha(identity("RRIOT_F722", "COMM"))).toBe(false);
    expect(isMigratedAlpha(identity("TMOTORG4ALPHA", "COMM"))).toBe(false);
    expect(isMigratedAlpha(identity("TMOTORG4ALPHAHD", "COMM", "INAV"))).toBe(false);
  });
});

describe("board report and texts", () => {
  it("records the readings, the class and the confirmations", () => {
    const current = readings();
    const report = buildBoardReport({ probe: { model: "ST-Link/V2", firmware: "V2J39S7" }, readings: current, classification: classifyBoard(current), confirmations: [{ id: "C1", version: 1, at: "t" }], simulated: true, at: new Date(0) });
    expect(report.optionBytes.OPTR).toBe("0xFBEFF800");
    expect(report.classification).toMatchObject({ kind: "locked", rdpLevel: 1 });
    expect(report.savedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("asks for a typed word before the one-way step, and nowhere else", () => {
    const typed = Object.values(ALPHA_TEXTS).filter((text) => "typed" in text);
    expect(typed.map((text) => text.id)).toEqual(["C7"]);
    expect(ALPHA_TEXTS.unlock.paragraphs[0]).toBe("This step cannot be undone.");
  });
});
