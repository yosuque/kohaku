import { describe, expect, it } from "vitest";
import { createDailyTokenLedger } from "../src/daily-token-ledger.js";

const DAY1_START = Date.parse("2026-01-01T00:00:00.000Z");
const DAY1_LATE = Date.parse("2026-01-01T23:59:59.000Z");
const DAY2_START = Date.parse("2026-01-02T00:00:00.000Z");

describe("createDailyTokenLedger", () => {
  it("starts at zero for a key that has never recorded", () => {
    const ledger = createDailyTokenLedger(() => DAY1_START);
    expect(ledger.spent("tenant-a")).toBe(0);
  });

  it("accumulates within the same UTC day", () => {
    let clock = DAY1_START;
    const ledger = createDailyTokenLedger(() => clock);
    ledger.record("tenant-a", 100);
    clock = DAY1_LATE;
    ledger.record("tenant-a", 50);
    expect(ledger.spent("tenant-a")).toBe(150);
  });

  it("resets automatically across a UTC day boundary", () => {
    let clock = DAY1_LATE;
    const ledger = createDailyTokenLedger(() => clock);
    ledger.record("tenant-a", 500);
    expect(ledger.spent("tenant-a")).toBe(500);

    clock = DAY2_START;
    expect(ledger.spent("tenant-a")).toBe(0); // reads as reset before any new record
    ledger.record("tenant-a", 10);
    expect(ledger.spent("tenant-a")).toBe(10); // did not carry yesterday's 500 forward
  });

  it("keys are independent", () => {
    const ledger = createDailyTokenLedger(() => DAY1_START);
    ledger.record("tenant-a", 100);
    ledger.record("tenant-b", 5);
    expect(ledger.spent("tenant-a")).toBe(100);
    expect(ledger.spent("tenant-b")).toBe(5);
  });

  it("defaults to Date.now when no clock is injected", () => {
    const ledger = createDailyTokenLedger();
    ledger.record("tenant-a", 42);
    expect(ledger.spent("tenant-a")).toBe(42);
  });

  it("day boundary is UTC, not local time (a date crossing midnight UTC rolls over)", () => {
    // 2026-01-01T23:00:00Z and 2026-01-02T01:00:00Z: 2 hours apart, but different UTC calendar days.
    let clock = Date.parse("2026-01-01T23:00:00.000Z");
    const ledger = createDailyTokenLedger(() => clock);
    ledger.record("tenant-a", 100);
    clock = Date.parse("2026-01-02T01:00:00.000Z");
    expect(ledger.spent("tenant-a")).toBe(0);
  });

  it("bounds memory with maxEntries, evicting the least-recently-touched entry first", () => {
    const ledger = createDailyTokenLedger(() => DAY1_START, { maxEntries: 2 });
    ledger.record("a", 1);
    ledger.record("b", 2); // at capacity
    ledger.record("a", 10); // touch a again -- LRU order becomes [b, a]
    ledger.record("c", 3); // c is new: evicts the LRU entry (b), not a

    expect(ledger.spent("a")).toBe(11); // untouched by eviction: 1 + 10
    expect(ledger.spent("b")).toBe(0); // evicted -- recording again would start a fresh entry
    expect(ledger.spent("c")).toBe(3);
  });

  it("prunes entries from a previous UTC day on rollover, so they never compete with today's keys for maxEntries", () => {
    let clock = DAY1_START;
    const ledger = createDailyTokenLedger(() => clock, { maxEntries: 2 });
    ledger.record("day1-a", 100);
    ledger.record("day1-b", 200); // at capacity, both from day 1

    clock = DAY2_START;
    ledger.record("day2-x", 5); // first day-2 call: day 1's entries are pruned before this is added
    ledger.record("day2-y", 7); // a second brand-new key for day 2 -- must not evict day2-x

    expect(ledger.spent("day2-x")).toBe(5); // survived: day 1's entries did not occupy its slot
    expect(ledger.spent("day2-y")).toBe(7);
    expect(ledger.spent("day1-a")).toBe(0);
    expect(ledger.spent("day1-b")).toBe(0);
  });
});
