import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { chooseCandidateIndex, indexValues, isIndexExhaustive } from "../src/lineage.js";

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
  it("treats an empty-string tenant like an absent one (normalizeTenant)", () => {
    expect(indexValues(ev({ tenant: "" }))).toEqual([{ field: "type", value: "view.composed" }]);
  });
});

describe("chooseCandidateIndex", () => {
  it("prefers the payload hash fields over type/tenant", () => {
    expect(chooseCandidateIndex({ type: ["a"], tenant: "t", intentHash: "h" })).toEqual({
      field: "intentHash",
      values: ["h"],
    });
    expect(chooseCandidateIndex({ artifactId: "a1", specHash: "s1" })).toEqual({
      field: "artifactId",
      values: ["a1"],
    });
  });
  it("prefers a single type over tenant", () => {
    expect(chooseCandidateIndex({ type: ["a"], tenant: "t" })).toEqual({ field: "type", values: ["a"] });
    expect(chooseCandidateIndex({ type: ["a", "b"], tenant: "t" })).toEqual({
      field: "type",
      values: ["a", "b"],
    });
  });
  it("falls back to tenant when there is no type filter", () => {
    expect(chooseCandidateIndex({ tenant: "t" })).toEqual({ field: "tenant", values: ["t"] });
  });
  it("treats an empty-string tenant filter as unspecified (no candidate from it)", () => {
    expect(chooseCandidateIndex({ tenant: "" })).toBeNull();
  });
  it("returns null when only since/until/limit are given, or type is an empty array (scan by-seq)", () => {
    expect(chooseCandidateIndex({ since: "2026", limit: 5 })).toBeNull();
    expect(chooseCandidateIndex({ type: [] })).toBeNull();
  });
});

describe("isIndexExhaustive", () => {
  it("is true when the filter has no predicate beyond the chosen candidate", () => {
    expect(isIndexExhaustive({ tenant: "t" }, { field: "tenant", values: ["t"] })).toBe(true);
    expect(isIndexExhaustive({ type: ["a", "b"] }, { field: "type", values: ["a", "b"] })).toBe(true);
  });
  it("is false when since/until is also set", () => {
    expect(isIndexExhaustive({ tenant: "t", since: "2026-01-01" }, { field: "tenant", values: ["t"] })).toBe(
      false,
    );
    expect(isIndexExhaustive({ tenant: "t", until: "2026-01-01" }, { field: "tenant", values: ["t"] })).toBe(
      false,
    );
  });
  it("is false when another field is also set", () => {
    expect(isIndexExhaustive({ type: ["a"], tenant: "t" }, { field: "type", values: ["a"] })).toBe(false);
    expect(
      isIndexExhaustive({ intentHash: "h", artifactId: "a" }, { field: "intentHash", values: ["h"] }),
    ).toBe(false);
  });
  it("limit alone does not affect exhaustiveness", () => {
    expect(isIndexExhaustive({ tenant: "t", limit: 5 }, { field: "tenant", values: ["t"] })).toBe(true);
  });
});
