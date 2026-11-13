import { describe, expect, it } from "vitest";
import { crc8DvbS2, encodeRequest, encodeV1, encodeV2, MspDecoder } from "../src/msp/codec.js";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

describe("MSP encoding", () => {
  it("encodes a v1 request with an xor checksum", () => {
    expect(hex(encodeV1(1))).toBe("244d3c000101");
  });

  it("encodes a v2 request with a DVB-S2 checksum", () => {
    const frame = encodeV2(0x3006, Uint8Array.of(5));
    expect(hex(frame.subarray(0, 8))).toBe("24583c0006300100");
    expect(frame[8]).toBe(5);
    expect(frame[9]).toBe(crc8DvbS2(frame.subarray(3, 9)));
  });

  it("uses v2 only for commands v1 cannot carry", () => {
    expect(encodeRequest(5)[1]).toBe(0x4d);
    expect(encodeRequest(0x3006)[1]).toBe(0x58);
  });
});

describe("MSP decoding", () => {
  it("decodes a frame captured from a real board", () => {
    const frames = new MspDecoder().push(fromHex("244d3e0301" + "00012e" + "11"));
    expect(frames).toHaveLength(0);
    const checksum = 3 ^ 1 ^ 0 ^ 1 ^ 0x2e;
    const valid = new MspDecoder().push(fromHex("244d3e030100012e" + checksum.toString(16).padStart(2, "0")));
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ version: 1, command: 1, error: false });
    expect(hex(valid[0]!.payload)).toBe("00012e");
  });

  it("reassembles frames split across chunks and skips noise", () => {
    const decoder = new MspDecoder();
    const noise = new TextEncoder().encode("###ERROR$$");
    const checksum = 1 ^ 2 ^ 0x41;
    const frame = Uint8Array.of(0x24, 0x4d, 0x3e, 1, 2, 0x41, checksum);
    expect(decoder.push(noise)).toHaveLength(0);
    expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
    const frames = decoder.push(frame.subarray(3));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload[0]).toBe(0x41);
  });

  it("reports the firmware error direction", () => {
    const body = Uint8Array.of(0, 0x06, 0x30, 0, 0);
    const frame = Uint8Array.of(0x24, 0x58, 0x21, ...body, crc8DvbS2(body));
    const frames = new MspDecoder().push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ version: 2, command: 0x3006, error: true });
  });
});
