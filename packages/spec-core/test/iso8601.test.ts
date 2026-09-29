import { describe, expect, it } from "vitest";
import { parseIso8601 } from "../src/iso8601.js";

describe("parseIso8601", () => {
  it("canonicalizes to UTC ISO 8601", () => {
    expect(parseIso8601("2026-09-30")).toBe("2026-09-30T00:00:00.000Z");
    expect(parseIso8601("2026-09-30T09:00:00+09:00")).toBe("2026-09-30T00:00:00.000Z");
    expect(parseIso8601("2026-09-30T00:00:00.5Z")).toBe("2026-09-30T00:00:00.500Z");
  });

  it.each(["July 9, 2026", "2026-9-30", "2026-09-30T00:00:00", "2026-13-01", "", "2026-09-30 00:00:00Z"])(
    "rejects %j",
    (raw) => {
      expect(parseIso8601(raw)).toBeNull();
    },
  );
});
