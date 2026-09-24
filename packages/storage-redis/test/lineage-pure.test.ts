import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { chooseCandidateIndex, indexValues, matchesFilter, tailLimit } from "../src/lineage.js";

function ev(
  partial: Partial<LineageEventRecord> & { payload?: Record<string, unknown> },
): LineageEventRecord {
  return {
    id: partial.id ?? "e1",
    ts: partial.ts ?? "2026-01-01T00:00:00.000Z",
    actor: { kind: "system" },
    type: partial.type ?? "view.composed",
    payload: partial.payload ?? {},
    ...(partial.tenant != null ? { tenant: partial.tenant } : {}),
  };
}

describe("indexValues", () => {
  it("emits one entry per present index field (type always; tenant / hashes only when present)", () => {
    expect(
      indexValues(ev({ payload: { intentHash: "sha256:a", specHash: "sha256:s" }, tenant: "acme" })),
    ).toEqual([
      { field: "type", value: "view.composed" },
      { field: "tenant", value: "acme" },
      { field: "intentHash", value: "sha256:a" },
      { field: "specHash", value: "sha256:s" },
    ]);
    expect(indexValues(ev({}))).toEqual([{ field: "type", value: "view.composed" }]);
  });
  it("ignores a non-string payload hash", () => {
    expect(indexValues(ev({ payload: { artifactId: 42 } }))).toEqual([
      { field: "type", value: "view.composed" },
    ]);
  });
});

describe("chooseCandidateIndex", () => {
  it("prefers the most selective index", () => {
    expect(chooseCandidateIndex({ type: ["a"], tenant: "t", intentHash: "h" })).toEqual({
      field: "intentHash",
      values: ["h"],
    });
    expect(chooseCandidateIndex({ type: ["a"], tenant: "t" })).toEqual({ field: "tenant", values: ["t"] });
    expect(chooseCandidateIndex({ type: ["a", "b"] })).toEqual({ field: "type", values: ["a", "b"] });
  });
  it("returns null when only since/until/limit are given (scan by-seq)", () => {
    expect(chooseCandidateIndex({ since: "2026", limit: 5 })).toBeNull();
    expect(chooseCandidateIndex({ type: [] })).toBeNull();
  });
});

describe("matchesFilter", () => {
  const e = ev({
    ts: "2026-05-01T00:00:00.000Z",
    tenant: "acme",
    payload: { intentHash: "h1", artifactId: "a1" },
  });
  it("ANDs every predicate", () => {
    expect(matchesFilter(e, {})).toBe(true);
    expect(
      matchesFilter(e, { type: ["view.composed"], tenant: "acme", intentHash: "h1", artifactId: "a1" }),
    ).toBe(true);
    expect(matchesFilter(e, { tenant: "globex" })).toBe(false);
    expect(matchesFilter(e, { specHash: "x" })).toBe(false);
    expect(matchesFilter(e, { since: "2026-05-01T00:00:00.000Z", until: "2026-05-01T00:00:00.000Z" })).toBe(
      true,
    );
    expect(matchesFilter(e, { since: "2026-05-02T00:00:00.000Z" })).toBe(false);
    expect(matchesFilter(e, { until: "2026-04-30T00:00:00.000Z" })).toBe(false);
  });
  it("a tenant filter excludes tenant-less events", () => {
    expect(matchesFilter(ev({}), { tenant: "acme" })).toBe(false);
  });
});

describe("tailLimit", () => {
  it("returns the last `limit` items, default 200, empty for limit <= 0", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(tailLimit(items, 3)).toEqual([247, 248, 249]);
    expect(tailLimit(items, undefined)).toHaveLength(200);
    expect(tailLimit(items, undefined)[0]).toBe(50);
    expect(tailLimit(items, 0)).toEqual([]);
    expect(tailLimit(items, -1)).toEqual([]);
  });
});
