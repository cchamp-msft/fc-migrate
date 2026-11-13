import { describe, expect, it } from "vitest";
import { doubleWordRuns, pagesTouched } from "../src/targets/stm32g4/flash.js";
import { decodeOptr, OptrPlanError, planOptrChange, rdpLevelOf, type OptrChange } from "../src/targets/stm32g4/option-bytes.js";

const NSWBOOT0 = 1 << 26;

describe("decodeOptr", () => {
  it("decodes the values the notes record", () => {
    expect(decodeOptr(0xfbeff800)).toMatchObject({ rdp: 0x00, rdpLevel: 1, nSwBoot0: false, nBoot0: true, dualBank: true, boot0PinHonoured: false });
    expect(decodeOptr(0xfbeff8aa)).toMatchObject({ rdp: 0xaa, rdpLevel: 0, nSwBoot0: false, nBoot0: true, dualBank: true });
    expect(decodeOptr(0xffeff8aa)).toMatchObject({ rdp: 0xaa, rdpLevel: 0, nSwBoot0: true, boot0PinHonoured: true });
    expect(decodeOptr(0xfbeff801)).toMatchObject({ rdp: 0x01, rdpLevel: 1 });
    expect(decodeOptr(0xfbeff8cc)).toMatchObject({ rdp: 0xcc, rdpLevel: 2 });
  });

  it("treats every RDP byte but 0xAA and 0xCC as Level 1", () => {
    expect(rdpLevelOf(0xaa)).toBe(0);
    expect(rdpLevelOf(0xcc)).toBe(2);
    for (const rdp of [0x00, 0x01, 0xbb, 0xab, 0xff]) expect(rdpLevelOf(rdp)).toBe(1);
  });
});

describe("planOptrChange", () => {
  it("regresses the stock value to Level 0 and keeps every other bit", () => {
    expect(planOptrChange(0xfbeff801, ["rdp->L0"])).toEqual({ before: 0xfbeff801, after: 0xfbeff8aa, changes: ["rdp->L0"] });
    expect(planOptrChange(0xfbeff800, ["rdp->L0"])).toEqual({ before: 0xfbeff800, after: 0xfbeff8aa, changes: ["rdp->L0"] });
  });

  it("clears nSWBOOT0 alone or together with RDP", () => {
    expect(planOptrChange(0xffeff800, ["rdp->L0", "nSWBOOT0->0"]).after).toBe(0xfbeff8aa);
    expect(planOptrChange(0xffeff8aa, ["nSWBOOT0->0"])).toEqual({ before: 0xffeff8aa, after: 0xfbeff8aa, changes: ["nSWBOOT0->0"] });
  });

  it("does not regress RDP when only nSWBOOT0 is asked for", () => {
    expect(planOptrChange(0xffeff800, ["nSWBOOT0->0"]).after).toBe(0xfbeff800);
  });

  it("lists only the changes that alter a bit", () => {
    expect(planOptrChange(0xfbeff8aa, ["rdp->L0", "nSWBOOT0->0"])).toEqual({ before: 0xfbeff8aa, after: 0xfbeff8aa, changes: [] });
  });

  it("refuses a chip at Level 2", () => {
    expect(() => planOptrChange(0xfbeff8cc, ["rdp->L0"])).toThrow(OptrPlanError);
    expect(() => planOptrChange(0xfbeff8cc, ["nSWBOOT0->0"])).toThrow(OptrPlanError);
  });

  it("refuses any other change", () => {
    for (const change of ["rdp->L2", "rdp->L1", "nSWBOOT0->1", "nBOOT0->0", "DBANK->0", "", "RDP->L0"]) {
      expect(() => planOptrChange(0xfbeff800, [change as OptrChange])).toThrow(OptrPlanError);
    }
    expect(() => planOptrChange(0xfbeff800, ["rdp->L0", "rdp->L2" as OptrChange])).toThrow(OptrPlanError);
  });

  it("refuses an empty request and malformed values", () => {
    expect(() => planOptrChange(0xfbeff800, [])).toThrow(OptrPlanError);
    for (const before of [-1, 0x1_0000_0000, 1.5, Number.NaN]) expect(() => planOptrChange(before, ["rdp->L0"])).toThrow(OptrPlanError);
  });

  it("never produces RDP 0xCC and never touches other bits, for any input", () => {
    let state = 0x12345678;
    const next = (): number => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>>= 0);
    };
    const requests: OptrChange[][] = [["rdp->L0"], ["nSWBOOT0->0"], ["rdp->L0", "nSWBOOT0->0"], ["nSWBOOT0->0", "rdp->L0"]];
    const samples = [...Array.from({ length: 2000 }, next), 0, 0xffffffff, 0xffffff00, 0xfbeff8bb];
    for (const before of samples) {
      for (const request of requests) {
        if ((before & 0xff) === 0xcc) {
          expect(() => planOptrChange(before, request)).toThrow(OptrPlanError);
          continue;
        }
        const { after } = planOptrChange(before, request);
        expect(after & 0xff).not.toBe(0xcc);
        expect((after ^ before) & ~(0xff | NSWBOOT0)).toBe(0);
        if (request.includes("rdp->L0")) expect(after & 0xff).toBe(0xaa);
        else expect(after & 0xff).toBe(before & 0xff);
        if (request.includes("nSWBOOT0->0")) expect(after & NSWBOOT0).toBe(0);
        else expect(after & NSWBOOT0).toBe(before & NSWBOOT0);
      }
    }
  });
});

describe("flash page plan", () => {
  const block = (address: number, length: number, fill = 0x11) => ({ address, bytes: new Uint8Array(length).fill(fill) });

  it("lists each touched 2 KB page once, by bank", () => {
    const pages = pagesTouched([block(0x08000000, 0x100), block(0x08006000, 3000), block(0x0803fff0, 0x20), block(0x08041003, 5)]);
    expect(pages.map((page) => [page.bank, page.index])).toEqual([
      [1, 0],
      [1, 12],
      [1, 13],
      [1, 127],
      [2, 0],
      [2, 2],
    ]);
    expect(pages.find((page) => page.bank === 2 && page.index === 0)!.address).toBe(0x08040000);
  });

  it("leaves the config area alone unless a block covers it", () => {
    const pages = pagesTouched([block(0x08000000, 0x2800), block(0x08006000, 0x100)]);
    expect(pages.some((page) => page.address >= 0x08004000 && page.address < 0x08006000)).toBe(false);
  });

  it("refuses blocks outside main flash", () => {
    expect(() => pagesTouched([block(0x07fffff0, 0x20)])).toThrow(RangeError);
    expect(() => pagesTouched([block(0x0807fff0, 0x20)])).toThrow(RangeError);
    expect(() => pagesTouched([block(0x1fff7800, 8)])).toThrow(RangeError);
  });

  it("aligns runs to double words, padding with 0xFF and merging shared double words", () => {
    const runs = doubleWordRuns([block(0x08041003, 2, 0xaa), block(0x08041005, 4, 0xbb), block(0x08041100, 3, 0xcc)]);
    expect(runs.map((run) => [run.address, run.bytes.length])).toEqual([
      [0x08041000, 16],
      [0x08041100, 8],
    ]);
    expect([...runs[0]!.bytes]).toEqual([0xff, 0xff, 0xff, 0xaa, 0xaa, 0xbb, 0xbb, 0xbb, 0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect([...runs[1]!.bytes]).toEqual([0xcc, 0xcc, 0xcc, 0xff, 0xff, 0xff, 0xff, 0xff]);
  });
});
