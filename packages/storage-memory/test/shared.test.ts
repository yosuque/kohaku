import {
  applyLineageLimit,
  DEFAULT_LINEAGE_LIMIT,
  type LineageEventRecord,
  type LineageFilter,
  matchesLineageFilter,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { filterLineage } from "../src/shared.js";

function event(i: number, type: string, tenant?: string): LineageEventRecord {
  return {
    id: `e${i}`,
    type,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    actor: { kind: "system" },
    payload: { intentHash: `h${i % 3}` },
    ...(tenant != null ? { tenant } : {}),
  };
}

/** The previous implementation: filter the whole list, then take the tail window. */
function reference(events: readonly LineageEventRecord[], filter: LineageFilter): LineageEventRecord[] {
  return applyLineageLimit(
    events.filter((e) => matchesLineageFilter(e, filter)),
    filter.limit,
  );
}

describe("filterLineage", () => {
  const events = Array.from({ length: 500 }, (_, i) =>
    event(i, i % 2 === 0 ? "composed" : "served", i % 5 === 0 ? "t1" : undefined),
  );

  const filters: LineageFilter[] = [
    {},
    { limit: 1 },
    { limit: 7 },
    { limit: 499 },
    { limit: 500 },
    { limit: 10_000 },
    { limit: 0 },
    { limit: -0 },
    { limit: -3 },
    { limit: 2.5 },
    { limit: 0.5 },
    { limit: Number.NaN },
    { type: ["composed"], limit: 5 },
    { type: ["composed"] },
    { tenant: "t1", limit: 3 },
    { intentHash: "h1", limit: 4 },
    { intentHash: "h1", type: ["served"], tenant: "t1", limit: 50 },
    { intentHash: "no-such-hash", limit: 5 },
  ];

  for (const filter of filters) {
    it(`matches filter-then-slice for ${JSON.stringify(filter)}`, () => {
      expect(filterLineage(events, filter)).toEqual(reference(events, filter));
    });
  }

  it("returns the tail window in ascending order and defaults to DEFAULT_LINEAGE_LIMIT", () => {
    const tail = filterLineage(events, { limit: 3 });
    expect(tail.map((e) => e.id)).toEqual(["e497", "e498", "e499"]);
    expect(filterLineage(events)).toHaveLength(DEFAULT_LINEAGE_LIMIT);
  });

  it("handles an empty list", () => {
    expect(filterLineage([], { limit: 5 })).toEqual([]);
  });
});
