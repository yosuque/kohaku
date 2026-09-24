import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { summarizeLineage } from "../src/index.js";

// Tests for the pure aggregation summarizeLineage of usage analytics:
// - view.composed count / tier distribution / cache breakdown / durationMs quantiles / top frequent intents
// - view.fallback per-kind breakdown and fallback rate
// - promotion / fixation event counts
// - pre-filtering by tenant / since / until
// The event schema is unchanged (it only reads existing payloads).

let seq = 0;
/** A small factory that creates one view.composed (payload only as needed for aggregation). */
function composed(
  args: {
    tier?: "L0" | "L1" | "L2";
    cache?: string;
    durationMs?: number;
    intentHash?: string;
    canonical?: string;
    tenant?: string;
    ts?: string;
  } = {},
): LineageEventRecord {
  return {
    id: `ev-${seq++}`,
    ts: args.ts ?? "2026-07-01T00:00:00.000Z",
    actor: { kind: "model" },
    type: "view.composed",
    payload: {
      tier: args.tier ?? "L1",
      cache: args.cache ?? "miss",
      intentHash: args.intentHash ?? "sha256:aaa",
      canonical: args.canonical ?? "sales.trend",
      ...(args.durationMs != null ? { durationMs: args.durationMs } : {}),
    },
    ...(args.tenant != null ? { tenant: args.tenant } : {}),
  };
}

function ev(
  type: string,
  payload: Record<string, unknown> = {},
  extra: { tenant?: string; ts?: string } = {},
): LineageEventRecord {
  return {
    id: `ev-${seq++}`,
    ts: extra.ts ?? "2026-07-01T00:00:00.000Z",
    actor: { kind: "system" },
    type,
    payload,
    ...(extra.tenant != null ? { tenant: extra.tenant } : {}),
  };
}

describe("summarizeLineage (pure aggregation of usage analytics)", () => {
  it("counts view.composed count / tier distribution / cache breakdown", () => {
    const s = summarizeLineage([
      composed({ tier: "L0", cache: "fixated" }),
      composed({ tier: "L1", cache: "hit" }),
      composed({ tier: "L1", cache: "miss" }),
      composed({ tier: "L2", cache: "bypass" }),
      composed({ tier: "L1", cache: "weird" }), // unknown cache goes to other
    ]);
    expect(s.composed).toBe(5);
    expect(s.tiers).toEqual({ L0: 1, L1: 3, L2: 1 });
    expect(s.cache).toEqual({ hit: 1, miss: 1, bypass: 1, fixated: 1, other: 1 });
  });

  it("produces view.fallback total / per-kind breakdown / fallback rate", () => {
    const s = summarizeLineage([
      composed(),
      composed(),
      composed(),
      ev("view.fallback", { reason: "generation failed", kind: "generation" }),
      ev("view.fallback", { reason: "capability", kind: "negotiation" }),
      ev("view.fallback", { reason: "unknown" }), // kind unspecified
    ]);
    expect(s.composed).toBe(3);
    expect(s.fallback.total).toBe(3);
    expect(s.fallback.byKind).toEqual({ generation: 1, negotiation: 1, unspecified: 1 });
    // rate = 3 / (3 composed + 3 fallback) = 0.5
    expect(s.fallback.rate).toBeCloseTo(0.5, 10);
  });

  it("fallback rate is 0 when there is neither presentation nor fallback (no division by zero)", () => {
    const s = summarizeLineage([ev("view.rendered", { specHash: "x" })]);
    expect(s.fallback.rate).toBe(0);
    expect(s.composed).toBe(0);
  });

  it("computes durationMs quantiles (nearest-rank) only from view.composed that have durationMs", () => {
    const s = summarizeLineage([
      composed({ durationMs: 10 }),
      composed({ durationMs: 20 }),
      composed({ durationMs: 30 }),
      composed({ durationMs: 40 }),
      composed({ durationMs: 100 }),
      composed({}), // no durationMs = outside the population
    ]);
    expect(s.durationMs.count).toBe(5);
    // nearest-rank: p50 = ceil(0.5*5)=3rd (index2)=30, p95=ceil(0.95*5)=5th=100, p99 also 5th=100
    expect(s.durationMs.p50).toBe(30);
    expect(s.durationMs.p95).toBe(100);
    expect(s.durationMs.p99).toBe(100);
    expect(s.durationMs.max).toBe(100);
  });

  it("quantiles are null when there is no durationMs", () => {
    const s = summarizeLineage([composed({}), composed({})]);
    expect(s.durationMs).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null });
  });

  it("returns the top N frequent intents in descending count order, including canonical", () => {
    const s = summarizeLineage(
      [
        composed({ intentHash: "sha256:a", canonical: "sales.trend" }),
        composed({ intentHash: "sha256:a", canonical: "sales.trend" }),
        composed({ intentHash: "sha256:a", canonical: "sales.trend" }),
        composed({ intentHash: "sha256:b", canonical: "sales.kpi" }),
        composed({ intentHash: "sha256:b", canonical: "sales.kpi" }),
        composed({ intentHash: "sha256:c", canonical: "sales.calendar" }),
      ],
      { topIntentsLimit: 2 },
    );
    expect(s.topIntents).toEqual([
      { intentHash: "sha256:a", canonical: "sales.trend", count: 3 },
      { intentHash: "sha256:b", canonical: "sales.kpi", count: 2 },
    ]);
  });

  it("counts promotion lifecycle and fixation event counts", () => {
    const s = summarizeLineage([
      ev("component.generated", { artifactId: "art-1" }),
      ev("component.used", { artifactId: "art-1" }),
      ev("component.used", { artifactId: "art-1" }),
      ev("component.nominated", { artifactId: "art-1" }),
      ev("component.judged", { artifactId: "art-1" }),
      ev("component.reviewed", { artifactId: "art-1" }),
      ev("component.published", { artifactId: "art-1" }),
      ev("component.withdrawn", { artifactId: "art-1" }),
      ev("intent.fixated", { intentHash: "sha256:a" }),
      ev("intent.unfixated", { intentHash: "sha256:a" }),
    ]);
    expect(s.promotions).toEqual({
      generated: 1,
      used: 2,
      nominated: 1,
      schemaSuggested: 0,
      judged: 1,
      reviewed: 1,
      schemaEdited: 0,
      published: 1,
      withdrawn: 1,
    });
    expect(s.fixations).toEqual({ fixated: 1, unfixated: 1 });
  });

  it("with a tenant specified, aggregates only that tenant's events (unrecorded events excluded)", () => {
    const events = [
      composed({ tenant: "acme", tier: "L1" }),
      composed({ tenant: "acme", tier: "L2" }),
      composed({ tenant: "globex", tier: "L1" }),
      composed({ tier: "L0" }), // tenant not recorded (legacy)
    ];
    const acme = summarizeLineage(events, { tenant: "acme" });
    expect(acme.events).toBe(2);
    expect(acme.composed).toBe(2);
    expect(acme.tiers).toEqual({ L0: 0, L1: 1, L2: 1 });

    const globex = summarizeLineage(events, { tenant: "globex" });
    expect(globex.composed).toBe(1);
    expect(globex.tiers).toEqual({ L0: 0, L1: 1, L2: 0 });

    // tenant unset means all (including legacy).
    const all = summarizeLineage(events);
    expect(all.composed).toBe(4);
  });

  it("narrows the period with since / until (both boundaries inclusive)", () => {
    const events = [
      composed({ ts: "2026-06-30T23:59:59.000Z" }),
      composed({ ts: "2026-07-01T00:00:00.000Z" }),
      composed({ ts: "2026-07-15T12:00:00.000Z" }),
      composed({ ts: "2026-07-31T23:59:59.000Z" }),
      composed({ ts: "2026-08-01T00:00:01.000Z" }),
    ];
    const s = summarizeLineage(events, {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-31T23:59:59.000Z",
    });
    expect(s.composed).toBe(3);
  });

  it("returns a zero summary with all fields even for empty input", () => {
    const s = summarizeLineage([]);
    expect(s.events).toBe(0);
    expect(s.composed).toBe(0);
    expect(s.tiers).toEqual({ L0: 0, L1: 0, L2: 0 });
    expect(s.fallback.total).toBe(0);
    expect(s.fallback.rate).toBe(0);
    expect(s.topIntents).toEqual([]);
  });
});

describe("summarizeLineage: review turnaround and suggestion acceptance", () => {
  it("pairs component.nominated with the next component.reviewed(approve|reject) per (tenant, artifactId)", () => {
    const events = [
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T00:00:00.000Z" }),
      ev("component.nominated", { artifactId: "a2" }, { ts: "2026-07-01T00:00:00.000Z", tenant: "t1" }),
      ev("component.reviewed", { artifactId: "a1", decision: "approve" }, { ts: "2026-07-01T00:01:00.000Z" }),
      // requestChanges is not a completion: a1 is re-nominated and reviewed again later. The re-nomination at
      // 01:00:00 opens a fresh window (the previous one already closed via the approve above); the next
      // re-nomination at 02:00:00 does NOT overwrite it, since a window for a1 is already open -- so the
      // eventual reject at 02:03:00 measures the whole 01:00:00 -> 02:03:00 round-trip (1h3m), including the
      // requestChanges cycle in between, not just the last 3-minute gap since the second re-nomination.
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T01:00:00.000Z" }),
      ev(
        "component.reviewed",
        { artifactId: "a1", decision: "requestChanges" },
        { ts: "2026-07-01T01:00:30.000Z" },
      ),
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T02:00:00.000Z" }),
      ev("component.reviewed", { artifactId: "a1", decision: "reject" }, { ts: "2026-07-01T02:03:00.000Z" }),
      // a2 (tenant t1) is reviewed 5 minutes after its nomination
      ev(
        "component.reviewed",
        { artifactId: "a2", decision: "approve" },
        { ts: "2026-07-01T00:05:00.000Z", tenant: "t1" },
      ),
      // a reviewed without any preceding nominated is ignored
      ev("component.reviewed", { artifactId: "a3", decision: "approve" }, { ts: "2026-07-01T00:05:00.000Z" }),
    ];
    const s = summarizeLineage(events);
    // durations: a1 60_000 (first cycle), a2 300_000, a1 3_780_000 (second cycle: 01:00:00 -> 02:03:00)
    expect(s.review.count).toBe(3);
    expect(s.review.durationMs).toEqual({ p50: 300_000, p95: 3_780_000, max: 3_780_000 });
  });

  it("a re-nomination for a candidate whose window is already open does not restart the measurement", () => {
    // service.ts's "re-submit and approve" path routes a changes_requested candidate back through
    // act(..., { kind: "nominate", by: reviewer }, ...), which records a fresh component.nominated milliseconds
    // before the resulting component.reviewed(approve). requestChanges never closes the open window (only
    // approve/reject do), so by the time this second component.nominated fires, a1's window is still open from
    // the *original* nomination -- and, per the "do not overwrite an already-open window" rule, stays open. The
    // pairing therefore measures from the original nomination, not the near-instant re-nomination. This holds
    // regardless of who or what recorded either `component.nominated` (the pairing does not inspect `by`).
    const events = [
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T00:00:00.000Z" }),
      ev(
        "component.reviewed",
        { artifactId: "a1", decision: "requestChanges" },
        { ts: "2026-07-01T00:30:00.000Z" },
      ),
      // Re-nomination (e.g. reviewer-initiated resubmission), immediately followed by approve.
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T01:00:00.000Z" }),
      ev("component.reviewed", { artifactId: "a1", decision: "approve" }, { ts: "2026-07-01T01:00:00.050Z" }),
    ];
    const s = summarizeLineage(events);
    expect(s.review.count).toBe(1);
    // ~1 hour (the full round-trip from the original nomination), not the ~50ms since the re-nomination.
    expect(s.review.durationMs.p50).toBe(60 * 60 * 1000 + 50);
  });

  it("keys the pairing by (tenant, artifactId), not artifactId alone: the same artifactId under two tenants is measured independently", () => {
    const events = [
      // Both tenants nominate the SAME artifactId a1 at the same t0, BEFORE either is reviewed. If the pairing
      // key dropped tenant, tenantB's nomination would overwrite tenantA's open-nomination entry (both keyed
      // "a1"), and tenantA's review would then consume tenantB's later review's entry — since it is deleted on
      // first use, tenantB's own review would find no open nomination and be silently dropped.
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T00:00:00.000Z", tenant: "tenantA" }),
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T00:00:00.000Z", tenant: "tenantB" }),
      // Tenant A reviews 1 minute after its nomination.
      ev(
        "component.reviewed",
        { artifactId: "a1", decision: "approve" },
        { ts: "2026-07-01T00:01:00.000Z", tenant: "tenantA" },
      ),
      // Tenant B reviews 10 minutes after its nomination.
      ev(
        "component.reviewed",
        { artifactId: "a1", decision: "approve" },
        { ts: "2026-07-01T00:10:00.000Z", tenant: "tenantB" },
      ),
    ];
    const s = summarizeLineage(events);
    // Keying by (tenant, artifactId) keeps the two tenants' pairings independent: durations 60_000 (tenantA) and
    // 600_000 (tenantB). Dropping tenant from the key would collapse this to count=1, durations=[60_000] only
    // (tenantB's review would find its nomination already consumed by tenantA's review and be ignored).
    expect(s.review.count).toBe(2);
    expect(s.review.durationMs).toEqual({ p50: 60_000, p95: 600_000, max: 600_000 });
  });

  it("pairs correctly even when component.reviewed appears before its component.nominated in array order (stable sort by ts, #4.2)", () => {
    const events = [
      // The reviewed record sits FIRST in the input array, but its ts is later than the nomination's — the
      // pairing must sort by ts before scanning, not trust array order.
      ev("component.reviewed", { artifactId: "a1", decision: "approve" }, { ts: "2026-07-01T00:05:00.000Z" }),
      ev("component.nominated", { artifactId: "a1" }, { ts: "2026-07-01T00:00:00.000Z" }),
    ];
    const s = summarizeLineage(events);
    expect(s.review.count).toBe(1);
    expect(s.review.durationMs.p50).toBe(5 * 60 * 1000);
  });

  it("review is empty when nothing was reviewed", () => {
    const s = summarizeLineage([ev("component.nominated", { artifactId: "a1" })]);
    expect(s.review).toEqual({ count: 0, durationMs: { p50: null, p95: null, max: null }, acceptedAsIs: 0 });
  });

  it("counts schemaSuggested / schemaEdited and the zero-edit + acknowledged acceptances", () => {
    const events = [
      ev("component.schemaSuggested", { artifactId: "a1", suggestion: {} }),
      ev("component.schemaSuggested", { artifactId: "a2", suggestion: {} }),
      ev("component.schemaEdited", {
        artifactId: "a1",
        changed: [],
        unchanged: ["componentType"],
        acknowledged: true,
      }),
      ev("component.schemaEdited", {
        artifactId: "a2",
        changed: [{ field: "description", suggested: "a", final: "b" }],
        unchanged: [],
        acknowledged: true,
      }),
    ];
    const s = summarizeLineage(events);
    expect(s.promotions.schemaSuggested).toBe(2);
    expect(s.promotions.schemaEdited).toBe(2);
    // Only a1 has both changed: [] and acknowledged: true; a2 was edited so it never qualifies regardless.
    expect(s.review.acceptedAsIs).toBe(1);
  });

  it("acceptedAsIs requires acknowledged === true even with an empty changed (#9)", () => {
    const events = [
      // No edits, but no acknowledgment recorded (a missing field, same as false): does not count.
      ev("component.schemaEdited", { artifactId: "a1", changed: [], unchanged: ["componentType"] }),
      // No edits, explicit acknowledged: false: does not count.
      ev("component.schemaEdited", {
        artifactId: "a2",
        changed: [],
        unchanged: ["componentType"],
        acknowledged: false,
      }),
      // No edits and acknowledged: true: counts.
      ev("component.schemaEdited", {
        artifactId: "a3",
        changed: [],
        unchanged: ["componentType"],
        acknowledged: true,
      }),
    ];
    const s = summarizeLineage(events);
    expect(s.promotions.schemaEdited).toBe(3);
    expect(s.review.acceptedAsIs).toBe(1);
  });
});
