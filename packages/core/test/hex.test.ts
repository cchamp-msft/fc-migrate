import { describe, expect, it } from "vitest";
import { HexParseError, parseIntelHex } from "../src/firmware/hex.js";

function record(type: number, offset: number, payload: number[]): string {
  const body = [payload.length, offset >> 8, offset & 0xff, type, ...payload];
  const checksum = -body.reduce((sum, byte) => sum + byte, 0) & 0xff;
  return `:${[...body, checksum].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

const EOF = record(0x01, 0, []);
const upperAddress = (upper: number) => record(0x04, 0, [upper >> 8, upper & 0xff]);
const data = (offset: number, ...bytes: number[]) => record(0x00, offset, bytes);
const file = (...lines: string[]) => [...lines, EOF, ""].join("\n");

/** Flips the low bit of the checksum so only the checksum is wrong. */
function corruptChecksum(line: string): string {
  const last = Number.parseInt(line.slice(-2), 16) ^ 0x01;
  return line.slice(0, -2) + last.toString(16).padStart(2, "0").toUpperCase();
}

describe("parseIntelHex", () => {
  it("decodes data records with extended linear addressing", () => {
    const image = parseIntelHex(file(upperAddress(0x0800), data(0x0000, 1, 2, 3, 4)));
    expect(image.bytesTotal).toBe(4);
    expect(image.data).toEqual([{ address: 0x08000000, bytes: Uint8Array.of(1, 2, 3, 4) }]);
  });

  it("merges contiguous records and keeps gaps as separate blocks", () => {
    const image = parseIntelHex(file(upperAddress(0x0800), data(0x0000, 1, 2), data(0x0002, 3, 4), data(0x0010, 5)));
    expect(image.data).toEqual([
      { address: 0x08000000, bytes: Uint8Array.of(1, 2, 3, 4) },
      { address: 0x08000010, bytes: Uint8Array.of(5) },
    ]);
    expect(image.bytesTotal).toBe(5);
  });

  it("merges records that are contiguous across a 64 KiB boundary", () => {
    const image = parseIntelHex(file(upperAddress(0x0800), data(0xfffe, 1, 2), upperAddress(0x0801), data(0x0000, 3, 4)));
    expect(image.data).toEqual([{ address: 0x0800fffe, bytes: Uint8Array.of(1, 2, 3, 4) }]);
  });

  it("does not merge records whose low addresses line up in different segments", () => {
    const image = parseIntelHex(file(upperAddress(0x0800), data(0x0000, 1, 2), upperAddress(0x0900), data(0x0002, 3, 4)));
    expect(image.data.map((block) => block.address)).toEqual([0x08000000, 0x09000002]);
  });

  it("accepts CRLF line endings, blank lines and lowercase digits", () => {
    const text = [upperAddress(0x0800).toLowerCase(), "", data(0x0000, 0xab), EOF, "", ""].join("\r\n");
    expect(parseIntelHex(text).data).toEqual([{ address: 0x08000000, bytes: Uint8Array.of(0xab) }]);
  });

  it("ignores start address records and a zero segment", () => {
    const image = parseIntelHex(
      file(record(0x02, 0, [0, 0]), record(0x03, 0, [0, 0, 0, 0]), upperAddress(0x0800), data(0, 7), record(0x05, 0, [8, 0, 0, 1])),
    );
    expect(image.data).toEqual([{ address: 0x08000000, bytes: Uint8Array.of(7) }]);
  });

  it("returns an empty image for a file with only an end-of-file record", () => {
    expect(parseIntelHex(file())).toEqual({ data: [], bytesTotal: 0 });
  });

  it.each([
    ["a corrupt data record", file(corruptChecksum(data(0, 1, 2)))],
    ["a corrupt address record", file(corruptChecksum(upperAddress(0x0800)), data(0, 1))],
    ["a corrupt end-of-file record", `${corruptChecksum(EOF)}\n`],
    // Both of these would pass the checksum if the digits were not checked first.
    ["a non-hex digit", file(":01000000ZZFF")],
    ["the wrong start code", file(`;${data(0, 1).slice(1)}`)],
    ["a line without a start code", file(data(0, 1).slice(1))],
    ["an odd number of digits", file(data(0, 1).slice(0, -1))],
    ["a truncated record", file(data(0, 1, 2).slice(0, -4))],
    ["a byte count that does not match", file(":0200000001FD")],
    ["an unknown record type", file(record(0x06, 0, []))],
    ["a missing end-of-file record", `${data(0, 1)}\n`],
    ["records after the end-of-file record", `${EOF}\n${data(0, 1)}\n`],
    ["a non-zero extended segment", file(record(0x02, 0, [0x10, 0x00]), data(0, 1))],
    ["a malformed address record", file(record(0x04, 0, [0x08]))],
  ])("rejects %s", (_name, text) => {
    expect(() => parseIntelHex(text)).toThrow(HexParseError);
  });

  it("names the offending line", () => {
    const text = file(upperAddress(0x0800), data(0, 1), corruptChecksum(data(1, 2)));
    expect(() => parseIntelHex(text)).toThrow(/line 3/);
  });
});
