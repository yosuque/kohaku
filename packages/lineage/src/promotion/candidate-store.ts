import {
  GOVERNANCE_ERROR_DISCRIMINATORS,
  type LineageEventRecord,
  type PromotionState,
  PromotionStateSchema,
  type StoragePort,
} from "@kohaku-ui/spec-core";
import { GENERATED_SCAN_WINDOW } from "../constants.js";
import { type TenantScope, tenantField } from "../tenant-scope.js";
import type { PromotionCandidate, PromotionOrigin } from "./candidate.js";
import { notifyPromotionError, type PromotionErrorContext } from "./errors.js";
import type { ComponentDraft, PromotionStatus } from "./machine.js";
import type { SchemaSuggestion } from "./suggestion.js";
import type { createUsageIndex } from "./usage.js";
import { indexLatestGenerated, tallyUsage, usageIndexKey } from "./usage.js";

type UsageIndex = ReturnType<typeof createUsageIndex>;

/**
 * Extracts PromotionOrigin (kit / generatorVersion / model) from a `component.generated` payload.
 * Returns undefined rather than `{}` when none of the three are present, so loadCandidate's
 * payload-or-stored-fallback (below) can tell "nothing on this payload" apart from "an empty origin".
 */
function originFromPayload(payload: Record<string, unknown> | undefined): PromotionOrigin | undefined {
  if (payload == null) return undefined;
  const origin: PromotionOrigin = {
    ...(payload["kit"] != null ? { kit: payload["kit"] as { id: string; version: string } } : {}),
    ...(payload["generatorVersion"] != null
      ? { generatorVersion: payload["generatorVersion"] as string }
      : {}),
    ...(payload["model"] != null ? { model: payload["model"] as string } : {}),
  };
  return Object.keys(origin).length > 0 ? origin : undefined;
}

/**
 * Read/projection side of the promotion pipeline, split out of createPromotions (a God-factory split):
 * candidate hydration (load), snapshot persistence (persist), and the two read-only
 * candidate collections (scan / listByStatus) that createPromotions, nominateEligible, and the HTTP
 * layer all build on. Contains no side effects beyond `persist` itself and never calls lineage.record
 * (audit recording stays the caller's responsibility) — nominateEligible (promotion/nomination.ts) and
 * createPromotions (promotion/service.ts) layer their own side effects (nominate audit, act's transition
 * + audit) on top of `load` / `persist` / `require`.
 */
export interface CandidateStore {
  load(
    artifactId: string,
    options?: {
      tenant?: string;
      usageStats?: { uses: number; sessions: number };
      generatedEvent?: { ts: string; payload: Record<string, unknown> };
    },
  ): Promise<PromotionCandidate | null>;
  persist(candidate: PromotionCandidate, tenant?: string): Promise<void>;
  /**
   * Batch counterpart of `persist`: persists several candidates in as few storage round trips as the
   * StoragePort allows. Uses `storage.putPromotionStates` when the port implements it (one read-modify-write for
   * the whole batch); otherwise falls back to calling `persist` once per candidate (legacy behavior, unchanged).
   * A no-op for an empty list.
   */
  persistMany(items: { candidate: PromotionCandidate; tenant?: string }[]): Promise<void>;
  scan(tenant?: string): Promise<PromotionCandidate[]>;
  /**
   * Same population as `scan`, but each candidate is paired with its own owning tenant (the tenant recorded on
   * its `component.generated` event), needed by `evaluateAndList`'s write path (promotion/nomination.ts) to
   * detect a candidate whose owning tenant does not match the call-level scope (#10; see nomination.ts's
   * tenant-mismatch skip). `scan` itself does not need this (it is read-only).
   */
  scanWithTenant(tenant?: string): Promise<{ candidate: PromotionCandidate; tenant?: string }[]>;
  require(artifactId: string, tenant?: string): Promise<PromotionCandidate>;
  listByStatus(status: PromotionStatus, scope?: TenantScope): Promise<PromotionCandidate[]>;
  /**
   * Reads the usage and `component.generated` bulk indexes once (scoped to `tenant`; unset = all tenants) and
   * returns a loader for the N+1-avoiding callers — see the `bulkLoader` implementation below.
   */
  bulkLoader(tenant?: string): Promise<BulkCandidateLoader>;
}

/** Result of `CandidateStore.bulkLoader`: the latest `component.generated` event per `(tenant, artifactId)` key and a per-candidate `load` that reuses the bulk indexes. */
export interface BulkCandidateLoader {
  /** Latest `component.generated` event per `usageIndexKey(tenant, artifactId)` (see `indexLatestGenerated`). */
  latestGenerated: ReadonlyMap<string, LineageEventRecord>;
  load(artifactId: string, recordTenant: string | undefined): Promise<PromotionCandidate | null>;
}

export function createCandidateStore(opts: {
  storage: StoragePort;
  usage: UsageIndex;
  /** Clock injection point (tests only; defaults to the real wall clock). */
  now?: () => Date;
  /**
   * Fail-open observability hook (product responsibility, optional), forwarded as-is from
   * createPromotions' own `onError`: notified when a promotion-state record read back from storage fails
   * schema validation (endpoint "storage.record.invalid" — see PromotionErrorEndpoint's doc).
   */
  onError?: (ctx: PromotionErrorContext, error: unknown) => void;
}): CandidateStore {
  const { storage, usage, onError } = opts;
  const now = (): Date => opts.now?.() ?? new Date();

  /**
   * Validates a promotion-state record read back from storage against PromotionStateSchema, treating a
   * validation failure exactly like a real absence (null): loadCandidate's existing
   * `state?.status ?? "in_use"` / `state?.data[...]` fallbacks already do the right thing with a null state,
   * so a corrupted record degrades to "no persisted state" rather than propagating a broken shape.
   */
  function validatePromotionState(
    raw: PromotionState | null,
    artifactId: string,
    tenant: string | undefined,
  ): PromotionState | null {
    if (raw == null) return null;
    const parsed = PromotionStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data as PromotionState;
    notifyPromotionError(
      onError,
      { endpoint: "storage.record.invalid", artifactId, ...tenantField(tenant) },
      parsed.error,
    );
    return null;
  }

  /**
   * loadCandidate. If usageStats is unset, it individually fetches via usage.forArtifact (get / act path).
   * evaluateAndList computes usage for all artifacts at once from a single listLineage and injects it, avoiding
   * the N+1 (O(K×N)) of linearly scanning the append-only lineage per candidate.
   * component.generated can similarly be injected via generatedEvent: scanCandidates always injects it (from its
   * own component.generated scan), and both listByStatus (below) and reconcile (service.ts) also inject it from
   * their own single bulk `listLineage({ type: ["component.generated"] })` fetch, keyed the same way
   * (`usageIndexKey`). A candidate whose generated event has aged out of GENERATED_SCAN_WINDOW (rare -- the
   * window is large) is simply absent from that bulk fetch, so generatedEvent comes through as `undefined` and
   * this function falls back to its own per-artifact lookup below, unchanged from before. (A snapshot-duplicate
   * short-circuit -- skipping the lookup outright when a published snapshot already carries its own html copy,
   * #9 -- is a separate optimization, not implemented here.)
   */
  async function loadCandidate(
    artifactId: string,
    options?: {
      tenant?: string;
      usageStats?: { uses: number; sessions: number };
      generatedEvent?: { ts: string; payload: Record<string, unknown> };
    },
  ): Promise<PromotionCandidate | null> {
    const { tenant, generatedEvent } = options ?? {};
    let usageStats = options?.usageStats;
    // Narrow the promotion state by tenant too. Even if the same artifactId exists for multiple tenants,
    // read only this tenant's state so status/verdict/draft do not get mixed. Fetched before the
    // component.generated lookup below because a self-contained published snapshot (persist's html/sha256/ref
    // copy, #9) can make the generated lookup unnecessary entirely.
    const state = validatePromotionState(
      await storage.getPromotionState(artifactId, tenant),
      artifactId,
      tenant,
    );
    const generated =
      generatedEvent != null
        ? [generatedEvent]
        : await storage.listLineage({
            type: ["component.generated"],
            artifactId,
            limit: 1,
            ...tenantField(tenant),
          });
    const payload = generated[0]?.payload;
    // Self-contained published projection (#9): once published, persist duplicates html/sha256/ref onto the
    // snapshot itself, so a lineage.jsonl replacement/loss no longer makes a published (or previously-published)
    // component unrecoverable — prefer the snapshot's own copy and fall back to component.generated otherwise.
    const snapshotHtml = state?.data["html"] as string | undefined;
    if (payload == null && snapshotHtml == null) return null;
    usageStats ??= await usage.forArtifact(artifactId, tenant);
    // Generation provenance: prefer the freshly-scanned component.generated payload; fall back to what was already
    // persisted (state.data.origin) once the generated event ages out of GENERATED_SCAN_WINDOW — the
    // same pattern `request` above uses, so origin survives indefinitely once captured.
    const origin = originFromPayload(payload) ?? (state?.data["origin"] as PromotionOrigin | undefined);
    return {
      artifactId,
      status: (state?.status as PromotionStatus | undefined) ?? "in_use",
      canonical: payload?.["canonical"] as string | undefined,
      request: (payload?.["request"] as string | undefined) ?? (state?.data["request"] as string | undefined),
      html: snapshotHtml ?? (payload?.["html"] as string | undefined),
      sha256:
        (state?.data["sha256"] as string | undefined) ?? (payload?.["artifactSha256"] as string | undefined),
      ref: (state?.data["ref"] as string | undefined) ?? (payload?.["ref"] as string | undefined),
      uses: usageStats.uses,
      sessions: usageStats.sessions,
      verdict: state?.data["verdict"],
      draft: state?.data["draft"] as ComponentDraft | undefined,
      ...(state?.data["suggestion"] != null
        ? { suggestion: state.data["suggestion"] as unknown as SchemaSuggestion }
        : {}),
      ...(origin != null ? { origin } : {}),
      updatedAt: state?.updatedAt ?? generated[0]?.ts ?? new Date(0).toISOString(),
    };
  }

  /**
   * Builds the persisted PromotionState shape for a candidate (the pure part of `persist`, factored out so
   * `persistMany` can build several states before issuing a single storage write).
   */
  function buildPromotionState(candidate: PromotionCandidate, tenant?: string): PromotionState {
    return {
      artifactId: candidate.artifactId,
      status: candidate.status,
      updatedAt: now().toISOString(),
      // Stamp the owning tenant. The StoragePort uses this value to key-separate state by (tenant, artifactId).
      ...tenantField(tenant),
      data: {
        ...(candidate.verdict != null ? { verdict: candidate.verdict } : {}),
        ...(candidate.draft != null ? { draft: candidate.draft } : {}),
        // The advisory schema suggestion (promotion/suggestion.ts). Kept across every transition once attached
        // at nomination, so the approval UI can still prefill after a changes_requested round-trip.
        ...(candidate.suggestion != null ? { suggestion: candidate.suggestion } : {}),
        ...(candidate.request != null ? { request: candidate.request } : {}),
        // Generation provenance (kit / generatorVersion / model), captured once from the candidate's
        // component.generated event and kept across every transition (unlike html/sha256/ref below, which
        // are a publish-time projection) — read by the migration planner to flag a published component
        // whose kit no longer matches the catalog's current one.
        ...(candidate.origin != null ? { origin: candidate.origin } : {}),
        // Self-contained published projection (#9): once the candidate reaches published, duplicate what
        // `reconcile` needs to rebuild the projection (html/sha256/ref/componentType) directly onto the
        // snapshot. Without this, reconcile depends on the `component.generated` lineage event surviving
        // indefinitely — a lineage.jsonl replacement/loss silently makes a published component vanish on the
        // next startup reconcile even though the state authority (promotions.json) still says "published".
        // Not copied on other transitions (including unpublish's own persist call, whose candidate.status is
        // already "withdrawn" by the time it runs): a withdrawn/rejected snapshot has no projection to rebuild
        // from html, and dropping it there keeps the persisted shape unchanged for every non-publish transition
        // (see promotion-golden.test.ts's characterization of the exact persisted key set).
        ...(candidate.status === "published"
          ? {
              ...(candidate.html != null ? { html: candidate.html } : {}),
              ...(candidate.sha256 != null ? { sha256: candidate.sha256 } : {}),
              ...(candidate.ref != null ? { ref: candidate.ref } : {}),
              ...(candidate.draft?.componentType != null
                ? { componentType: candidate.draft.componentType }
                : {}),
            }
          : {}),
      },
    };
  }

  async function persist(candidate: PromotionCandidate, tenant?: string): Promise<void> {
    await storage.putPromotionState(buildPromotionState(candidate, tenant));
  }

  /**
   * Batch counterpart of `persist`: builds every state up front, then issues either one
   * `putPromotionStates` call (StoragePort implements the batch extension) or falls back to the legacy
   * one-`putPromotionState`-call-per-state loop. A no-op for an empty list.
   */
  async function persistMany(items: { candidate: PromotionCandidate; tenant?: string }[]): Promise<void> {
    if (items.length === 0) return;
    const states = items.map(({ candidate, tenant }) => buildPromotionState(candidate, tenant));
    if (storage.putPromotionStates != null) {
      await storage.putPromotionStates(states);
    } else {
      for (const state of states) await storage.putPromotionState(state);
    }
  }

  /**
   * Performs the two bulk index reads the N+1-avoiding callers (scanCandidatesWithTenant, listByStatus and
   * service.ts's reconcile) each need exactly once — the (tenant, artifactId)-keyed component.used index (for the
   * window-drift known constraint, see the usage.index doc) and a single fetch of the most recent
   * GENERATED_SCAN_WINDOW component.generated events reduced to the latest per key — and returns a `load` that
   * hydrates one candidate from them. A candidate whose generated event has aged out of that window is simply
   * absent from `latestGenerated`, so `load` falls back to loadCandidate's own per-artifact lookup, unchanged.
   * `recordTenant` is the record's own tenant (not the call-level scope), the same as everywhere else.
   */
  async function bulkLoader(tenant?: string): Promise<BulkCandidateLoader> {
    const usedByArtifact = await usage.index(tenant);
    const generated = await storage.listLineage({
      type: ["component.generated"],
      limit: GENERATED_SCAN_WINDOW,
      ...tenantField(tenant),
    });
    const latestGenerated = indexLatestGenerated(generated);
    return {
      latestGenerated,
      load(artifactId, recordTenant) {
        const key = usageIndexKey(recordTenant, artifactId);
        return loadCandidate(artifactId, {
          tenant: recordTenant,
          usageStats: tallyUsage(usedByArtifact.get(key) ?? []),
          generatedEvent: latestGenerated.get(key),
        });
      },
    };
  }

  /**
   * Pure read scan (no side effects), paired with each candidate's own owning tenant. The shared core behind
   * `scanCandidates` / `list` / `listByStatus`'s in_use branch, and `evaluateAndList`'s read step (before
   * `nominateEligible`'s side effects, which needs the per-candidate tenant to detect a tenant mismatch, #10).
   */
  async function scanCandidatesWithTenant(
    tenant?: string,
  ): Promise<{ candidate: PromotionCandidate; tenant?: string }[]> {
    // Aggregation covers only the most recent GENERATED_SCAN_WINDOW component.generated events. Anything beyond is dropped.
    // In the future, move toward a since window or an aggregate query (DB backend).
    // When tenant is given, scan only that tenant's records (unset = all = legacy behavior).
    // Key candidates by (tenant, artifactId) rather than artifactId alone (#10): artifactId derives from content
    // sha256 and is globally unique, so the *same* artifactId can be promoted independently by multiple tenants
    // (see promotion-tenant-mix.test.ts). Keying by artifactId alone when `tenant` is left unspecified (an
    // all-tenant scan) would collapse those tenants' independent generated events (and hence candidates) into
    // one, silently mixing their state. `e.tenant` is each event's own recorded tenant (equal to `tenant` when a
    // specific tenant was requested; the record's own value otherwise).
    const loader = await bulkLoader(tenant);
    const candidates: { candidate: PromotionCandidate; tenant?: string }[] = [];
    for (const event of loader.latestGenerated.values()) {
      const artifactId = event.payload["artifactId"] as string;
      const recordTenant = event.tenant;
      const candidate = await loader.load(artifactId, recordTenant);
      if (candidate == null) continue;
      candidates.push({ candidate, tenant: recordTenant });
    }
    return candidates.sort((a, b) => b.candidate.uses - a.candidate.uses);
  }

  async function scanCandidates(tenant?: string): Promise<PromotionCandidate[]> {
    return (await scanCandidatesWithTenant(tenant)).map((r) => r.candidate);
  }

  /**
   * Fetches an artifact as required. On not-found (including tenant mismatch) it throws unknown artifact,
   * carrying `code: artifactNotFoundCode` (spec-core's GOVERNANCE_ERROR_DISCRIMINATORS) so host-rest can
   * discriminate this case by code rather than a message-text match (a wording change here would otherwise
   * silently break a regex on the host side).
   * act / approve / reject / withdraw share the same loadCandidate call.
   */
  async function requireCandidate(artifactId: string, tenant?: string): Promise<PromotionCandidate> {
    const candidate = await loadCandidate(artifactId, { tenant });
    if (candidate == null) {
      throw Object.assign(new Error(`unknown artifact: ${artifactId}`), {
        code: GOVERNANCE_ERROR_DISCRIMINATORS.artifactNotFoundCode,
      });
    }
    return candidate;
  }

  /**
   * Per-status list (the changes_requested-to-candidate recovery path's read side). No side effects. Consistency
   * with the legacy list (full component.generated scan):
   * - status === "in_use": the promotion state is not saved (before nominate), so it does not appear in
   *   listPromotionStates. Collect the population with the same scanCandidates(tenant) as list and narrow to only
   *   in_use (the window constraint and population are the same as list).
   * - otherwise (from candidate onward, including terminal): it has persisted state, so use listPromotionStates
   *   (snapshot projection) as the index and enrich only the artifacts in that status via loadCandidate with
   *   uses/sessions/html etc. Since the snapshot is window-free, it also does not drop old published entries etc.
   *   that fall outside list's GENERATED_SCAN_WINDOW (in this respect it is more exhaustive than list).
   */
  async function listByStatus(status: PromotionStatus, scope?: TenantScope): Promise<PromotionCandidate[]> {
    const tenant = scope?.tenant;
    if (status === "in_use") {
      const all = await scanCandidates(tenant);
      return all.filter((c) => c.status === "in_use");
    }
    // Narrow to the requested status first. An empty match returns before any lineage read: the common case for
    // a poll of an empty queue (admin-react lists several statuses per refresh) must not pay for the
    // component.used / component.generated window reads below.
    const states = (await storage.listPromotionStates(tenant)).filter((state) => state.status === status);
    if (states.length === 0) return [];
    // Inject usage and component.generated into loadCandidate from the same bulk indexes scanCandidates and
    // reconcile use (see bulkLoader): a state whose generated event falls inside the scan window skips
    // loadCandidate's own individual listLineage lookup below.
    const loader = await bulkLoader(tenant);
    const candidates: PromotionCandidate[] = [];
    for (const state of states) {
      // Use each state's own recorded tenant (state.tenant), not the call-level `tenant` (#10): when `tenant`
      // is left unspecified (an all-tenant scan), listPromotionStates(undefined) returns every tenant's states
      // mixed together, and loading a tenant-owned state with tenant:undefined would miss its
      // component.generated / promotion-state lookups (they are keyed by the actual owning tenant), silently
      // falling back to a wrong/incomplete candidate. When a specific tenant was requested, state.tenant already
      // equals it (listPromotionStates(tenant) filters to that tenant), so this is a no-op for that case.
      const candidate = await loader.load(state.artifactId, state.tenant);
      // Something that has state but whose component.generated cannot be pulled (normally impossible) cannot be projected, so exclude it.
      if (candidate != null) candidates.push(candidate);
    }
    return candidates.sort((a, b) => b.uses - a.uses);
  }

  return {
    load: loadCandidate,
    persist,
    persistMany,
    scan: scanCandidates,
    scanWithTenant: scanCandidatesWithTenant,
    require: requireCandidate,
    listByStatus,
    bulkLoader,
  };
}
