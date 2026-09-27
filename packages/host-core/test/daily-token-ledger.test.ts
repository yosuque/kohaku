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
});
