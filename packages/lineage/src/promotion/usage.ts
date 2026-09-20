import type { StoragePort } from "@kohaku-ui/spec-core";
import { USAGE_SCAN_WINDOW } from "../constants.js";
import { tenantField } from "../tenant-scope.js";

/** Computes uses / sessions from a set of component.used events (shared by forArtifact and evaluateAndList). */
export function tallyUsage(used: { payload: Record<string, unknown> }[]): { uses: number; sessions: number } {
  // For promotion aggregation, uses treats the compose-time record (inside viewComposed, server-authoritative) as the source of truth.
  // Telemetry-path records (source:"telemetry") serve to observe actual-render success/failure and can be spoofed, so they are excluded from aggregation.
  const counted = used.filter((e) => e.payload["source"] !== "telemetry");
  const sessions = new Set(
    counted.map((e) => e.payload["sessionId"]).filter((s): s is string => typeof s === "string"),
  );
  return { uses: counted.length, sessions: Math.max(sessions.size, counted.length > 0 ? 1 : 0) };
}

/**
 * Composite key for the per-record usage index (`createUsageIndex.index`'s return value) and the matching
 * candidate-store lookups. artifactId derives from content sha256 and is unique across tenants, so the same
 * artifactId can be promoted independently by multiple tenants (see candidate-store.ts's scan). Keying by
 * artifactId alone (the pre-#10 behavior) would merge those tenants' usage counts together whenever an
 * aggregation scans without a tenant filter (tenant left unspecified); keying by `(tenant, artifactId)` instead
 * keeps them separate. `tenant` here is always the *record's own* tenant (e.g. `event.tenant`), not the
 * aggregation's requested scope.
 *
 * Encoded as a JSON array `[tenant ?? null, artifactId]` rather than a delimiter-joined string. The previous
 * encoding joined the two values with a single delimiter character (a NUL byte), which is not collision-free
 * by construction for a tenant or artifactId that could itself contain that character -- a JSON array is,
 * for any input. `tenant: undefined` and `tenant: ""` are intentionally distinct keys here (no caller relies
 * on them being merged; see usage.test.ts). This key is memory-only -- never persisted, since promotions.json
 * stores `tenant` and `artifactId` as separate fields -- so its exact encoding is free to change without a
 * migration.
 */
export function usageIndexKey(tenant: string | undefined, artifactId: string): string {
  return JSON.stringify([tenant ?? null, artifactId]);
}

/**
 * Reduces a set of lineage events (typically `component.generated`) to, per `(tenant, artifactId)` key (see
 * `usageIndexKey`), the single event with the greatest `ts`. Shared by the three call sites that each used to
 * build this same "latest generated per key" index with their own copy of the loop (service.ts's `reconcile`,
 * and candidate-store.ts's `scanCandidatesWithTenant` / `listByStatus`). An event whose `payload.artifactId`
 * is not a string is skipped: this matches two of those three sites' pre-existing filter exactly, and is a
 * deliberate behaviour change at the third (`scanCandidatesWithTenant`, which previously used an unchecked
 * `as string` cast with no guard) -- accepted as low-risk because the write path that produces
 * `component.generated` always sets a string `artifactId`, so this only changes what happens to an already-
 * malformed event: it is now skipped outright instead of indexed under a key built from a garbage cast value.
 */
export function indexLatestGenerated<
  E extends { ts: string; tenant?: string; payload: Record<string, unknown> },
>(events: E[]): Map<string, E> {
  const latest = new Map<string, E>();
  for (const e of events) {
    const artifactId = e.payload["artifactId"];
    if (typeof artifactId !== "string") continue;
    const key = usageIndexKey(e.tenant, artifactId);
    const prev = latest.get(key);
    if (prev == null || e.ts > prev.ts) latest.set(key, e);
  }
  return latest;
}

/**
 * Groups a set of component.used events by their (tenant, artifactId) composite key (see `usageIndexKey`), used
 * for bulk usage computation. Builds usage for all artifacts from a single listLineage, avoiding the N+1 of
 * calling listLineage per candidate (shared by scanCandidates and listByStatus via index).
 */
export function groupUsedByArtifact(
  used: { payload: Record<string, unknown>; tenant?: string }[],
): Map<string, { payload: Record<string, unknown>; tenant?: string }[]> {
  const byArtifact = new Map<string, { payload: Record<string, unknown>; tenant?: string }[]>();
  for (const e of used) {
    const artifactId = e.payload["artifactId"];
    if (typeof artifactId !== "string") continue;
    const key = usageIndexKey(e.tenant, artifactId);
    const list = byArtifact.get(key) ?? [];
    list.push(e);
    byArtifact.set(key, list);
  }
  return byArtifact;
}

/**
 * Aggregation index for component.used (depends only on storage, independent of state transitions).
 * `index` is the tail window across all artifacts combined; `forArtifact` is the per-artifact tail window.
 */
export function createUsageIndex(storage: StoragePort): {
  /** Individually fetch a single artifact's uses / sessions (get / act path). */
  forArtifact(artifactId: string, tenant?: string): Promise<{ uses: number; sessions: number }>;
  /**
   * Builds the (tenant, artifactId)-keyed index of component.used (see `usageIndexKey`; shared by scanCandidates
   * and listByStatus). Avoids the N+1 of calling listLineage per candidate by fetching component.used just once
   * with limit USAGE_SCAN_WINDOW and grouping by the composite key. Unlike forArtifact (per-artifact with the same
   * limit), here it looks at the tail USAGE_SCAN_WINDOW events across all artifacts combined. If the total number
   * of component.used is within the window the two agree, but beyond that the windows diverge (overall tail
   * window vs per-artifact tail window), so it may deviate from the per-artifact aggregation — a known
   * constraint. In the future, move toward a since window or an aggregate query (DB backend). Grouping by the
   * composite key (rather than artifactId alone) additionally means that when `tenant` is left unspecified (an
   * all-tenant scan), the same globally-unique artifactId promoted independently by multiple tenants keeps each
   * tenant's usage separate instead of being summed together (#10).
   */
  index(tenant?: string): Promise<Map<string, { payload: Record<string, unknown>; tenant?: string }[]>>;
} {
  async function index(
    tenant?: string,
  ): Promise<Map<string, { payload: Record<string, unknown>; tenant?: string }[]>> {
    const allUsed = await storage.listLineage({
      type: ["component.used"],
      limit: USAGE_SCAN_WINDOW,
      ...tenantField(tenant),
    });
    return groupUsedByArtifact(allUsed);
  }

  async function forArtifact(
    artifactId: string,
    tenant?: string,
  ): Promise<{ uses: number; sessions: number }> {
    const used = await storage.listLineage({
      type: ["component.used"],
      artifactId,
      limit: USAGE_SCAN_WINDOW,
      ...tenantField(tenant),
    });
    return tallyUsage(used);
  }

  return { forArtifact, index };
}
