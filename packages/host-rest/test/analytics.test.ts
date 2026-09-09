import type { ComposeContext } from "@kohaku-ui/composer";
import { summarizeLineage } from "@kohaku-ui/lineage";
import type {
  AuthzPort,
  DomainPort,
  LineageEventRecord,
  LineageFilter,
  Principal,
  StoragePort,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// host-rest integration tests for the usage-analytics route (GET /analytics/summary):
// - Inject the real summarizeLineage; the aggregate values are correctly folded from the event stream.
// - authorizeGovernance deny -> 403 CAPABILITY_DENIED (the aggregator is not reached).
// - The tenant is resolved from the session, and at the storage stage other tenants' events do not mix in.
// - The window limits (default 200 / max 1000) are stated explicitly in the response window (not a silent cap).

const NO_COMPOSE = {} as unknown as ComposeContext;
const NO_AUTHZ = {} as unknown as AuthzPort;
const NO_DOMAIN = {} as unknown as DomainPort;

let seq = 0;
function composed(
  args: { tier?: "L0" | "L1" | "L2"; cache?: string; durationMs?: number; tenant?: string; ts?: string } = {},
): LineageEventRecord {
  return {
    id: `ev-${seq++}`,
    ts: args.ts ?? "2026-07-01T00:00:00.000Z",
    actor: { kind: "model" },
    type: "view.composed",
    payload: {
      tier: args.tier ?? "L1",
      cache: args.cache ?? "miss",
      intentHash: "sha256:aaa",
      canonical: "sales.trend",
      ...(args.durationMs != null ? { durationMs: args.durationMs } : {}),
    },
    ...(args.tenant != null ? { tenant: args.tenant } : {}),
  };
}

function fallback(tenant?: string): LineageEventRecord {
  return {
    id: `ev-${seq++}`,
    ts: "2026-07-01T00:00:00.000Z",
    actor: { kind: "system" },
    type: "view.fallback",
    payload: { specHash: "s", reason: "generation failed", kind: "generation" },
    ...(tenant != null ? { tenant } : {}),
  };
}

/**
 * A simple storage that respects since / until / tenant / limit (same behavior as the sample's storage-port).
 * until is applied **before** the tail slice (aligned with the implementation for bug reproduction / regression prevention).
 */
function analyticsStorage(events: LineageEventRecord[]): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage(filter: LineageFilter = {}) {
      let result = events;
      if (filter.since != null) result = result.filter((e) => e.ts >= filter.since!);
      if (filter.until != null) result = result.filter((e) => e.ts <= filter.until!);
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      return result.slice(-(filter.limit ?? 200));
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

function makeDeps(events: LineageEventRecord[], overrides: Partial<KohakuHostDeps> = {}): KohakuHostDeps {
  return {
    compose: { ...NO_COMPOSE, storage: analyticsStorage(events) } as unknown as ComposeContext,
    domain: NO_DOMAIN,
    authz: NO_AUTHZ,
    querySource: "sales",
    analyticsSummarizer: summarizeLineage,
    ...overrides,
  };
}

interface SummaryResponse {
  window: { limit: number; truncated: boolean; since?: string; until?: string; tenant?: string };
  summary: {
    events: number;
    composed: number;
    tiers: { L0: number; L1: number; L2: number };
    cache: { hit: number; miss: number; bypass: number; fixated: number; other: number };
    fallback: { total: number; byKind: Record<string, number>; rate: number };
    durationMs: {
      count: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
      max: number | null;
    };
    topIntents: { intentHash: string; canonical: string; count: number }[];
    promotions: Record<string, number>;
    fixations: { fixated: number; unfixated: number };
  };
}

describe("GET /analytics/summary (usage analytics route)", () => {
  it("folds the event stream into an aggregated summary (end-to-end of aggregate values)", async () => {
    const app = createKohakuRoutes(
      makeDeps([
        composed({ tier: "L0", cache: "fixated", durationMs: 5 }),
        composed({ tier: "L1", cache: "hit", durationMs: 10 }),
        composed({ tier: "L2", cache: "miss", durationMs: 30 }),
        fallback(),
      ]),
    );
    const res = await app.request("/analytics/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryResponse;
    expect(body.summary.composed).toBe(3);
    expect(body.summary.tiers).toEqual({ L0: 1, L1: 1, L2: 1 });
    expect(body.summary.cache).toEqual({ hit: 1, miss: 1, bypass: 0, fixated: 1, other: 0 });
    expect(body.summary.fallback.total).toBe(1);
    // rate = 1 / (3 + 1) = 0.25
    expect(body.summary.fallback.rate).toBeCloseTo(0.25, 10);
    expect(body.summary.durationMs.count).toBe(3);
    expect(body.summary.topIntents[0]).toEqual({
      intentHash: "sha256:aaa",
      canonical: "sales.trend",
      count: 3,
    });
    // State the default window (200) explicitly in window rather than as a silent cap.
    expect(body.window.limit).toBe(200);
    expect(body.window.truncated).toBe(false);
  });

  it("on authorization deny it returns 403 CAPABILITY_DENIED and never reaches the aggregator", async () => {
    let called = false;
    const app = createKohakuRoutes(
      makeDeps([composed()], {
        authorizeGovernance: () => false,
        analyticsSummarizer: () => {
          called = true;
          return {};
        },
      }),
    );
    const res = await app.request("/analytics/summary");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
    expect(called).toBe(false);
  });

  it("operation.kind is authorized as analytics.read", async () => {
    const seen: string[] = [];
    const app = createKohakuRoutes(
      makeDeps([composed()], {
        authorizeGovernance: (_p: Principal, op) => {
          seen.push(op.kind);
          return true;
        },
      }),
    );
    const res = await app.request("/analytics/summary");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["analytics.read"]);
  });

  it("the tenant is resolved from the session and other tenants' events do not mix into the aggregation", async () => {
    const events = [
      composed({ tenant: "acme", tier: "L1" }),
      composed({ tenant: "acme", tier: "L2" }),
      composed({ tenant: "globex", tier: "L1" }),
      composed({ tier: "L0" }), // legacy (tenant not recorded)
    ];
    const app = createKohakuRoutes(
      makeDeps(events, { tenant: (c) => c.req.header("x-kohaku-tenant") || undefined }),
    );

    const acme = (await (
      await app.request("/analytics/summary", {
        headers: { "x-kohaku-tenant": "acme" },
      })
    ).json()) as SummaryResponse;
    expect(acme.summary.composed).toBe(2);
    expect(acme.summary.tiers).toEqual({ L0: 0, L1: 1, L2: 1 });
    expect(acme.window.tenant).toBe("acme");

    const globex = (await (
      await app.request("/analytics/summary", {
        headers: { "x-kohaku-tenant": "globex" },
      })
    ).json()) as SummaryResponse;
    expect(globex.summary.composed).toBe(1);

    // Unspecified tenant is all (including legacy) = the legacy behavior equivalent to single tenant.
    const all = (await (await app.request("/analytics/summary")).json()) as SummaryResponse;
    expect(all.summary.composed).toBe(4);
  });

  it("limit is clamped to the ceiling of 1000 and reflected in window (not a silent cap)", async () => {
    const app = createKohakuRoutes(makeDeps([composed()]));
    const res = await app.request("/analytics/summary?limit=99999");
    const body = (await res.json()) as SummaryResponse;
    expect(body.window.limit).toBe(1000);
  });

  it("even when until is set in the past, the [since, until] window aggregates correctly (regression on the interaction with tail slice)", async () => {
    // Old in-window events (2) + new events after until (3).
    // Under the old behavior that applied until "after" the storage tail slice, listLineage returned the latest
    // limit events (= the new 3), which until then fully excluded, giving composed=0.
    // Under the current behavior that applies until "before" the slice, the 2 events in window [.., until] are aggregated correctly.
    const events = [
      composed({ ts: "2026-07-01T00:00:00.000Z", tier: "L0" }),
      composed({ ts: "2026-07-01T01:00:00.000Z", tier: "L1" }),
      composed({ ts: "2026-07-05T00:00:00.000Z", tier: "L2" }),
      composed({ ts: "2026-07-05T01:00:00.000Z", tier: "L2" }),
      composed({ ts: "2026-07-05T02:00:00.000Z", tier: "L2" }),
    ];
    const app = createKohakuRoutes(makeDeps(events));
    const res = await app.request("/analytics/summary?until=2026-07-02T00:00:00.000Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryResponse;
    // Only the 2 in-window events are aggregated (not buried by the new 3 and emptied out).
    expect(body.summary.composed).toBe(2);
    expect(body.summary.tiers).toEqual({ L0: 1, L1: 1, L2: 0 });
    expect(body.window.until).toBe("2026-07-02T00:00:00.000Z");
  });

  it("until is applied before the tail slice, and truncated is set when the in-window count exceeds limit (truncated's meaning is unchanged)", async () => {
    // 3 events in window [.., until], 1 after it. With limit=2, only the latest 2 in-window events are returned,
    // and older in-window events fall outside the window = truncated. Confirms until does not break truncated's meaning.
    const events = [
      composed({ ts: "2026-07-01T00:00:00.000Z", tier: "L0" }),
      composed({ ts: "2026-07-01T01:00:00.000Z", tier: "L1" }),
      composed({ ts: "2026-07-01T02:00:00.000Z", tier: "L2" }),
      composed({ ts: "2026-07-09T00:00:00.000Z", tier: "L2" }), // after until (outside the window)
    ];
    const app = createKohakuRoutes(makeDeps(events));
    const res = await app.request("/analytics/summary?until=2026-07-02T00:00:00.000Z&limit=2");
    const body = (await res.json()) as SummaryResponse;
    // Only the latest 2 in-window events (L1, L2) are aggregated; the older L0 falls outside the window via the tail slice.
    expect(body.summary.composed).toBe(2);
    expect(body.summary.tiers).toEqual({ L0: 0, L1: 1, L2: 1 });
    expect(body.window.limit).toBe(2);
    expect(body.window.truncated).toBe(true);
  });

  it("invalid since / until is 400 BAD_REQUEST", async () => {
    const app = createKohakuRoutes(makeDeps([composed()]));
    expect((await app.request("/analytics/summary?since=not-a-date")).status).toBe(400);
    expect((await app.request("/analytics/summary?until=not-a-date")).status).toBe(400);
  });

  it("when the aggregator is not wired it returns 501 NOT_IMPLEMENTED (governance passes but degraded)", async () => {
    const app = createKohakuRoutes(makeDeps([composed()], { analyticsSummarizer: undefined }));
    const res = await app.request("/analytics/summary");
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_IMPLEMENTED");
  });
});
