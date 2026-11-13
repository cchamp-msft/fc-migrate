import { describe, expect, it } from "vitest";
import { dailyLimits, DEFAULT_DAILY_LIMITS, refund, spend, visitorAddress, visitorKey } from "../src/budget.js";

const limits = { perVisitor: 2, total: 3 };

describe("daily budget", () => {
  it("counts calls per visitor and in total", () => {
    let state = spend(undefined, { day: "2026-11-13", visitor: "a", limits }).state;
    state = spend(state, { day: "2026-11-13", visitor: "a", limits }).state;
    expect(state).toEqual({ day: "2026-11-13", total: 2, visitors: { a: 2 } });
    expect(spend(state, { day: "2026-11-13", visitor: "a", limits }).verdict).toEqual({ ok: false, limit: "visitor" });
    state = spend(state, { day: "2026-11-13", visitor: "b", limits }).state;
    expect(spend(state, { day: "2026-11-13", visitor: "c", limits }).verdict).toEqual({ ok: false, limit: "total" });
  });

  it("leaves the counts alone when a call is refused", () => {
    const full = { day: "2026-11-13", total: 3, visitors: { a: 2, b: 1 } };
    expect(spend(full, { day: "2026-11-13", visitor: "b", limits }).state).toBe(full);
  });

  it("starts each UTC day from zero", () => {
    const yesterday = { day: "2026-11-12", total: 3, visitors: { a: 2, b: 1 } };
    expect(spend(yesterday, { day: "2026-11-13", visitor: "a", limits })).toEqual({ state: { day: "2026-11-13", total: 1, visitors: { a: 1 } }, verdict: { ok: true } });
  });

  it("gives back a call only on the same day, never below zero", () => {
    const today = { day: "2026-11-13", total: 2, visitors: { a: 1, b: 1 } };
    expect(refund(today, { day: "2026-11-13", visitor: "a" })).toEqual({ day: "2026-11-13", total: 1, visitors: { a: 0, b: 1 } });
    expect(refund(today, { day: "2026-11-14", visitor: "a" })).toBe(today);
    expect(refund({ day: "2026-11-13", total: 0, visitors: {} }, { day: "2026-11-13", visitor: "a" })).toEqual({ day: "2026-11-13", total: 0, visitors: { a: 0 } });
    expect(refund(undefined, { day: "2026-11-13", visitor: "a" })).toBeUndefined();
  });

  it("reads limits from dashboard variables, ignoring nonsense", () => {
    expect(dailyLimits({})).toEqual(DEFAULT_DAILY_LIMITS);
    expect(dailyLimits({ DAILY_LIMIT_PER_VISITOR: " 5 ", DAILY_LIMIT_TOTAL: "40" })).toEqual({ perVisitor: 5, total: 40 });
    expect(dailyLimits({ DAILY_LIMIT_PER_VISITOR: "0", DAILY_LIMIT_TOTAL: "lots" })).toEqual(DEFAULT_DAILY_LIMITS);
    expect(dailyLimits({ DAILY_LIMIT_PER_VISITOR: "2.5", DAILY_LIMIT_TOTAL: "-1" })).toEqual(DEFAULT_DAILY_LIMITS);
  });
});

describe("visitors", () => {
  it("keys a visitor by a hash that changes daily", async () => {
    const key = await visitorKey("203.0.113.9", "2026-11-13");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(await visitorKey("203.0.113.9", "2026-11-13")).toBe(key);
    expect(await visitorKey("203.0.113.10", "2026-11-13")).not.toBe(key);
    expect(await visitorKey("203.0.113.9", "2026-11-14")).not.toBe(key);
  });

  it("counts IPv4 per address", () => {
    expect(visitorAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(visitorAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(visitorAddress("unknown")).toBe("unknown");
  });

  it("counts IPv6 per /64, however the address is written", () => {
    const network = "2001:db8:85a3:42::/64";
    for (const address of ["2001:db8:85a3:42:1:2:3:4", "2001:0db8:85a3:0042:ffff:ffff:ffff:ffff", "2001:DB8:85A3:42::1", "2001:db8:85a3:42::"]) {
      expect(visitorAddress(address)).toBe(network);
    }
    expect(visitorAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(visitorAddress("::1")).toBe("0:0:0:0::/64");
    expect(visitorAddress("2001:db8:85a3:43::1")).not.toBe(network);
  });
});
