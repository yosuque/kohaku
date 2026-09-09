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
      judged: 1,
      reviewed: 1,
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
