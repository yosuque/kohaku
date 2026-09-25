import { describe, expect, it } from "vitest";
import {
  applyLineageLimit,
  DEFAULT_LINEAGE_LIMIT,
  LINEAGE_PAYLOAD_INDEX_FIELDS,
  matchesLineageFilter,
} from "../src/lineage-filter.js";
import type { LineageEventRecord } from "../src/ports.js";

function event(
  type: string,
  payload: Record<string, unknown>,
  ts: string,
  tenant?: string,
): LineageEventRecord {
  return {
    id: `${type}:${ts}:${tenant ?? ""}`,
    ts,
    actor: { kind: "system" },
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

describe("LINEAGE_PAYLOAD_INDEX_FIELDS", () => {
  it("lists exactly the payload fields matchesLineageFilter reads", () => {
    expect(LINEAGE_PAYLOAD_INDEX_FIELDS).toEqual(["intentHash", "artifactId", "specHash"]);
  });
});

describe("matchesLineageFilter", () => {
  const e = event(
    "view.composed",
    { intentHash: "h1", artifactId: "a1", specHash: "s1" },
    "2026-01-02T00:00:00.000Z",
    "t1",
  );

  it("matches an empty filter (no conditions)", () => {
    expect(matchesLineageFilter(e, {})).toBe(true);
  });

  it("filters by type membership", () => {
    expect(matchesLineageFilter(e, { type: ["view.composed"] })).toBe(true);
    expect(matchesLineageFilter(e, { type: ["component.used"] })).toBe(false);
  });

  it("filters by intentHash / artifactId / specHash payload equality", () => {
    expect(matchesLineageFilter(e, { intentHash: "h1" })).toBe(true);
    expect(matchesLineageFilter(e, { intentHash: "other" })).toBe(false);
    expect(matchesLineageFilter(e, { artifactId: "a1" })).toBe(true);
    expect(matchesLineageFilter(e, { artifactId: "other" })).toBe(false);
    expect(matchesLineageFilter(e, { specHash: "s1" })).toBe(true);
    expect(matchesLineageFilter(e, { specHash: "other" })).toBe(false);
  });

  it("applies since / until inclusively", () => {
    expect(matchesLineageFilter(e, { since: "2026-01-02T00:00:00.000Z" })).toBe(true);
    expect(matchesLineageFilter(e, { since: "2026-01-03T00:00:00.000Z" })).toBe(false);
    expect(matchesLineageFilter(e, { until: "2026-01-02T00:00:00.000Z" })).toBe(true);
    expect(matchesLineageFilter(e, { until: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("matches tenant by equality after normalizeTenant on both sides", () => {
    expect(matchesLineageFilter(e, { tenant: "t1" })).toBe(true);
    expect(matchesLineageFilter(e, { tenant: "t2" })).toBe(false);
  });

  it("treats an empty-string filter tenant as unspecified (matches regardless of the event's tenant)", () => {
    expect(matchesLineageFilter(e, { tenant: "" })).toBe(true);
    const tenantless = event("view.composed", {}, "2026-01-02T00:00:00.000Z");
    expect(matchesLineageFilter(tenantless, { tenant: "" })).toBe(true);
  });

  it("treats an empty-string event tenant as equivalent to no tenant when filtering by tenant", () => {
    const emptyTenant = event("view.composed", {}, "2026-01-02T00:00:00.000Z", "");
    expect(matchesLineageFilter(emptyTenant, { tenant: undefined })).toBe(true);
    // An explicit non-empty filter tenant still does not match an empty/absent event tenant.
    expect(matchesLineageFilter(emptyTenant, { tenant: "t1" })).toBe(false);
  });
});

describe("applyLineageLimit", () => {
  const items = [1, 2, 3, 4, 5];

  it("defaults to DEFAULT_LINEAGE_LIMIT when limit is omitted", () => {
    expect(DEFAULT_LINEAGE_LIMIT).toBe(200);
    expect(applyLineageLimit(items)).toEqual(items);
  });

  it("returns the tail `limit` items in original order", () => {
    expect(applyLineageLimit(items, 2)).toEqual([4, 5]);
  });

  it("returns everything when limit exceeds the list length", () => {
    expect(applyLineageLimit(items, 100)).toEqual(items);
  });

  it("returns an empty array for limit <= 0, including -0 and negative limits", () => {
    expect(applyLineageLimit(items, 0)).toEqual([]);
    expect(applyLineageLimit(items, -0)).toEqual([]);
    expect(applyLineageLimit(items, -1)).toEqual([]);
  });
});
