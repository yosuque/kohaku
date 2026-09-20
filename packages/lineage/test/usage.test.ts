import { describe, expect, it } from "vitest";
import { indexLatestGenerated, tallyUsage, usageIndexKey } from "../src/promotion/usage.js";

// Unit tests for tallyUsage's telemetry exclusion and sessions fallback.

describe("tallyUsage (uses / sessions aggregation of component.used)", () => {
  it("used with source:telemetry is excluded from uses / sessions", () => {
    const result = tallyUsage([
      { payload: { source: "telemetry", sessionId: "s-tele" } },
      { payload: { source: "telemetry" } },
    ]);
    expect(result).toEqual({ uses: 0, sessions: 0 });
  });

  it("only non-telemetry used are counted toward uses / sessions", () => {
    const result = tallyUsage([
      { payload: { sessionId: "s-a" } },
      { payload: { source: "compose", sessionId: "s-b" } },
      { payload: { source: "telemetry", sessionId: "s-tele" } },
      { payload: { sessionId: "s-a" } },
    ]);
    expect(result.uses).toBe(3);
    expect(result.sessions).toBe(2);
  });

  it("sessions falls back to 1 when there is counted usage even without a sessionId", () => {
    const result = tallyUsage([{ payload: { artifactId: "art-1" } }, { payload: {} }]);
    expect(result).toEqual({ uses: 2, sessions: 1 });
  });
});

describe("usageIndexKey (collision-free (tenant, artifactId) composite key)", () => {
  it("a space-containing tenant/artifactId pair does not collide across the split", () => {
    // The JSON-array encoding is collision-free for any input, including a tenant/artifactId pair that
    // contains the delimiter the previous encoding used (a NUL byte, not a space -- see usage.ts's doc
    // comment on usageIndexKey for what the previous encoding actually was).
    expect(usageIndexKey("a b", "c")).not.toBe(usageIndexKey("a", "b c"));
  });

  it('tenant undefined and tenant "" produce distinct keys (R2: no existing caller relies on their equivalence)', () => {
    expect(usageIndexKey(undefined, "x")).not.toBe(usageIndexKey("", "x"));
  });

  it("is a JSON array encoding of [tenant ?? null, artifactId]", () => {
    expect(usageIndexKey("acme", "art-1")).toBe(JSON.stringify(["acme", "art-1"]));
    expect(usageIndexKey(undefined, "art-1")).toBe(JSON.stringify([null, "art-1"]));
  });
});

describe("indexLatestGenerated (per (tenant, artifactId) key, the event with the greatest ts)", () => {
  it("keeps only the greatest-ts event per key when the same artifact/tenant repeats", () => {
    const older = { ts: "2026-01-01T00:00:00.000Z", tenant: "acme", payload: { artifactId: "art-1" } };
    const newer = { ts: "2026-01-02T00:00:00.000Z", tenant: "acme", payload: { artifactId: "art-1" } };
    const result = indexLatestGenerated([older, newer]);
    expect(result.size).toBe(1);
    expect(result.get(usageIndexKey("acme", "art-1"))).toBe(newer);
  });

  it("keeps entries separate across distinct (tenant, artifactId) keys", () => {
    const a = { ts: "2026-01-01T00:00:00.000Z", tenant: "acme", payload: { artifactId: "art-1" } };
    const b = { ts: "2026-01-01T00:00:00.000Z", tenant: "other", payload: { artifactId: "art-1" } };
    const c = { ts: "2026-01-01T00:00:00.000Z", tenant: undefined, payload: { artifactId: "art-2" } };
    const result = indexLatestGenerated([a, b, c]);
    expect(result.size).toBe(3);
    expect(result.get(usageIndexKey("acme", "art-1"))).toBe(a);
    expect(result.get(usageIndexKey("other", "art-1"))).toBe(b);
    expect(result.get(usageIndexKey(undefined, "art-2"))).toBe(c);
  });

  it("skips events whose payload.artifactId is not a string", () => {
    const missing = { ts: "2026-01-01T00:00:00.000Z", tenant: "acme", payload: {} };
    const wrongType = { ts: "2026-01-02T00:00:00.000Z", tenant: "acme", payload: { artifactId: 42 } };
    const valid = { ts: "2026-01-03T00:00:00.000Z", tenant: "acme", payload: { artifactId: "art-1" } };
    const result = indexLatestGenerated([missing, wrongType, valid]);
    expect(result.size).toBe(1);
    expect(result.get(usageIndexKey("acme", "art-1"))).toBe(valid);
  });
});
