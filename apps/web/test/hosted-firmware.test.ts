import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALPHA_BOARDS, checkAlphaImage, parseIntelHex } from "@bf-migrate/core";
import { describe, expect, it } from "vitest";
import { HOSTED_ALPHA_FIRMWARE } from "../src/data/hosted-firmware";

describe.each(Object.entries(HOSTED_ALPHA_FIRMWARE))("hosted firmware for %s", (boardId, firmware) => {
  const file = fileURLToPath(new URL(`../public/${firmware!.path}`, import.meta.url));
  const board = ALPHA_BOARDS.find((candidate) => candidate.id === boardId)!;

  it("serves exactly the release file it pins", () => {
    const bytes = readFileSync(file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(firmware!.sha256);
  });

  it("is built for the board it is offered to", () => {
    expect(firmware!.boardName).toBe(board.boardName);
  });

  it("passes the Alpha image check for real hardware, with no warning", () => {
    const check = checkAlphaImage(parseIntelHex(readFileSync(file, "utf8")), { board });
    expect(check).toMatchObject({ ok: true, demo: false, boardName: firmware!.boardName, coversSettings: false });
    expect(check.warnings).toEqual([]);
  });

  it("names the board and revision it claims", () => {
    const text = readFileSync(file, "utf8");
    const image = parseIntelHex(text);
    const ascii = Buffer.concat(image.data.map((block) => Buffer.from(block.bytes))).toString("latin1");
    expect(ascii).toContain(firmware!.boardName);
    expect(ascii).toContain(firmware!.revision);
    expect(ascii).toContain("COMM");
  });
});
