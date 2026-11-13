import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAlphaImage, parseIntelHex } from "@bf-migrate/core";
import { describe, expect, it } from "vitest";
import { ALPHA_HD_FIRMWARE } from "../src/data/hosted-firmware";

const file = fileURLToPath(new URL(`../public/${ALPHA_HD_FIRMWARE.path}`, import.meta.url));

describe("hosted firmware", () => {
  it("serves exactly the release file it pins", () => {
    const bytes = readFileSync(file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ALPHA_HD_FIRMWARE.sha256);
  });

  it("passes the Alpha image check for real hardware", () => {
    const check = checkAlphaImage(parseIntelHex(readFileSync(file, "utf8")));
    expect(check).toMatchObject({ ok: true, demo: false, boardName: ALPHA_HD_FIRMWARE.boardName, coversSettings: false });
  });

  it("names the board and revision it claims", () => {
    const text = readFileSync(file, "utf8");
    const image = parseIntelHex(text);
    const ascii = Buffer.concat(image.data.map((block) => Buffer.from(block.bytes))).toString("latin1");
    expect(ascii).toContain(ALPHA_HD_FIRMWARE.boardName);
    expect(ascii).toContain(ALPHA_HD_FIRMWARE.revision);
    expect(ascii).toContain("COMM");
  });
});
