import { describe, expect, it } from "vitest";
import { parseIso8601 } from "../src/iso8601.js";

describe("parseIso8601", () => {
  it("canonicalizes to UTC ISO 8601", () => {
    expect(parseIso8601("2026-09-30")).toBe("2026-09-30T00:00:00.000Z");
    expect(parseIso8601("2026-09-30T09:00:00+09:00")).toBe("2026-09-30T00:00:00.000Z");
    expect(parseIso8601("2026-09-30T00:00:00.5Z")).toBe("2026-09-30T00:00:00.500Z");
  });

  it("accepts a real leap day and the last valid clock time", () => {
    expect(parseIso8601("2028-02-29")).toBe("2028-02-29T00:00:00.000Z");
    expect(parseIso8601("2026-09-30T23:59:59Z")).toBe("2026-09-30T23:59:59.000Z");
  });

  it.each([
    "July 9, 2026",
    "2026-9-30",
    "2026-09-30T00:00:00",
    "2026-13-01",
    "",
    "2026-09-30 00:00:00Z",
    // Impossible calendar dates / clock times that Date.parse would roll over instead of rejecting.
    "2026-02-30",
    "2026-02-29",
    "2026-04-31",
    "2026-00-10",
    "2026-09-00",
    "2026-02-30T00:00:00Z",
    "2026-09-30T24:00:00Z",
    "2026-09-30T00:60:00Z",
    "2026-09-30T00:00:00+24:00",
  ])("rejects %j", (raw) => {
    expect(parseIso8601(raw)).toBeNull();
  });
});
