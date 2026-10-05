import {
  computeStructureHash,
  type FixationRecord,
  FixationRecordSchema,
  GOVERNANCE_ERROR_DISCRIMINATORS,
  type LineageEventRecord,
  type Principal,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { FIXATION_PROPOSAL_SCAN_WINDOW } from "../constants.js";
import type { ActorKind } from "../events.js";
import { notifyFailOpen } from "../fail-open.js";
import type { Lineage } from "../lineage.js";
import { type TenantScope, tenantField } from "../tenant-scope.js";

/**
 * Fail-fast error raised when unfixate is called on a StoragePort that does not implement deleteFixation.
 * Because the host layer cannot depend on lineage (dependency direction), the REST surface discriminates
 * structurally via the code property (spec-core's GOVERNANCE_ERROR_DISCRIMINATORS.fixationUnsupportedCode)
 * and maps it to an error envelope (501).
 */
export class FixationUnsupportedError extends Error {
  readonly code = GOVERNANCE_ERROR_DISCRIMINATORS.fixationUnsupportedCode;
  constructor(message = "unfixate requires a StoragePort.deleteFixation implementation") {
    super(message);
    this.name = "FixationUnsupportedError";
  }
}

/**
 * Raised by `fixate` when the Spec it is asked to pin must not become the permanent L0 fast path (SPEC.md §8):
 * a Spec carrying `provenance.fallback` (a generation failure or a capability-negotiation downgrade, not the
 * intended structure) or a tier-`L2` result (free-form, sandbox-only generation that the promotion pipeline,
 * not fixation, governs). Enforced here rather than only at the REST route so every caller of `fixate`
 * (an ingest pipeline, a CLI, a product's own code) is covered by the same rule.
 */
export class FixationNotAllowedError extends Error {
  constructor(
    readonly reason: "fallback" | "l2-tier",
    message: string,
  ) {
    super(message);
    this.name = "FixationNotAllowedError";
  }
}

export interface FixationPolicy {
  minUses: number;
  minDistinctSessions: number;
  /** Threshold for the ratio of the most frequent structureHash (structural stability) */
  structuralStability: number;
}

export const DEFAULT_FIXATION_POLICY: FixationPolicy = {
  minUses: 50,
  minDistinctSessions: 10,
  structuralStability: 0.95,
};

/**
 * The single call site `createFixations`' `onError` hook fires from, named for the observability hook: a
 * fixation record read back from `StoragePort.getFixation` (by `unfixate` / `invalidate` /
 * `refreshFingerprint`) failed `@kohaku-ui/spec-core`'s `FixationRecordSchema` (a corrupted or hand-edited
 * `fixations.json` entry). The reader treats the record as absent (the
 * same branch a real `null` takes), so a broken `pinnedSpec` never reaches the delivery path; this hook only
 * reports that it happened.
 */
export type FixationErrorEndpoint = "storage.record.invalid";

/** Context passed to `createFixations`' `onError` hook alongside the causing (zod) error. */
export interface FixationErrorContext {
  endpoint: FixationErrorEndpoint;
  intentHash: string;
  tenant?: string;
}

/**
 * Fires opts.onError fire-and-forget, swallowing any synchronous throw from the hook itself (an
 * observation-only hook must never mask or replace the caller's own error/result). Shares its implementation
 * with promotion's notifyPromotionError through the generic `notifyFailOpen`; only the context type differs
 * (intentHash vs. artifactId).
 */
export function notifyFixationError(
  onError: ((ctx: FixationErrorContext, error: unknown) => void) | undefined,
  ctx: FixationErrorContext,
  error: unknown,
): void {
  notifyFailOpen(onError, ctx, error);
}

export interface FixationProposal {
  intentHash: string;
  canonical: string;
  params?: Record<string, unknown>;
  uses: number;
  sessions: number;
  stability: number;
  tier: string;
}

/** The TOCTOU guard fields shared by `InvalidateOptions.guard` and `ReplaceOptions.guard` (see `guardMatches`). */
export interface FixationGuard {
  ifCatalogFingerprint?: string;
  ifFixatedAt?: string;
  ifRevision?: string;
}

/**
 * TOCTOU guard check shared by invalidate and replace: true when the current fixation still matches what was
 * observed at the time of the decision (re-approved after the decision = a mismatch = do not touch it). A
 * conditional write/delete that avoids sweeping up a new fixation in the window between the decision and the
 * write. ifRevision, when supplied, takes priority over ifFixatedAt (finer-grained: distinguishes a
 * same-millisecond unfixate→fixate pair); ifFixatedAt remains the fallback for callers/records that predate
 * revision, so a legacy record with no catalogFingerprint is still protected against a re-approval race.
 * ifCatalogFingerprint is checked independently of that pair.
 */
function guardMatches(existing: FixationRecord, guard: FixationGuard | undefined): boolean {
  if (guard?.ifRevision != null) {
    if (existing.revision !== guard.ifRevision) return false;
  } else if (guard?.ifFixatedAt != null && existing.fixatedAt !== guard.ifFixatedAt) {
    return false;
  }
  if (guard?.ifCatalogFingerprint != null && existing.catalogFingerprint !== guard.ifCatalogFingerprint) {
    return false;
  }
  return true;
}

/** Options for Fixations.invalidate: detail is an optional human-facing note, guard is the TOCTOU check, scope narrows the owning tenant. */
export interface InvalidateOptions extends TenantScope {
  detail?: string;
  /**
   * TOCTOU guard: delete only if the current fixation still matches what was observed at the time of the
   * stale decision. `ifCatalogFingerprint` compares the catalog fingerprint (when the fixation carries one).
   * `ifRevision`, when present, takes priority over `ifFixatedAt` (compares the fixation's monotonic
   * `revision` token, which — unlike `fixatedAt`'s ms-precision ISO timestamp — distinguishes an
   * unfixate → fixate pair that lands inside the same millisecond). `ifFixatedAt` is the fallback for
   * records that predate `revision` and should always be supplied by callers (including for legacy records
   * with no `catalogFingerprint`), so that a fixation re-approved between the stale decision and the delete
   * call is never swept up even without a fingerprint or a revision.
   */
  guard?: FixationGuard;
}

/** Options for Fixations.replace (design.md #65's catalog migration). */
export interface ReplaceOptions extends TenantScope {
  /** The human who approved applying the migration plan to this fixation. */
  approver: Principal;
  /**
   * TOCTOU guard: replace only if the current fixation still matches what host-core's
   * `planCatalogMigration` observed when it built the plan. Same `ifRevision` / `ifFixatedAt` /
   * `ifCatalogFingerprint` semantics as `InvalidateOptions.guard`, plus `ifStructureHash` — a migration
   * plan is built from a specific pinnedSpec structure, so `applyCatalogMigration` additionally guards on
   * the structure it actually planned against having stayed unchanged (unlike a plain staleness
   * invalidation, which only cares that *some* fixation is still there to delete).
   */
  guard?: FixationGuard & { ifStructureHash?: string };
  /** The migration plan's `planHash` (host-core's CatalogMigrationPlan), recorded on intent.migrated for audit traceability. */
  planId?: string;
}

export interface Fixations {
  /** Extract fixation candidates from frequently-used Intents (L1). scope.tenant narrows the aggregation and already-fixated check. */
  proposals(scope?: TenantScope): Promise<FixationProposal[]>;
  /** List of already-fixated entries. When scope.tenant is given, only that tenant's entries (unset = all = legacy behavior). */
  list(scope?: TenantScope): Promise<FixationRecord[]>;
  /**
   * Human-approved fixation. The structure of pinnedSpec is thereafter served as L0.
   * Passing tenant stamps it into record.tenant, and the StoragePort key-separates by (tenant, intentHash).
   * Throws {@link FixationNotAllowedError} for a Spec carrying `provenance.fallback` or a tier-`L2` Spec (SPEC.md §8).
   */
  fixate(args: { pinnedSpec: UISpec; approver: Principal; tenant?: string }): Promise<FixationRecord>;
  unfixate(intentHash: string, approver: Principal, scope?: TenantScope): Promise<void>;
  /**
   * Single fixation read by intentHash (schema-validated, like the storage reads unfixate / invalidate /
   * refreshFingerprint already perform — a corrupted record is treated as absent rather than thrown). Lets
   * host-rest derive its delivery-path `fixationLookup` from this API instead of reaching past it to
   * `StoragePort.getFixation` directly (see host-rest's `FixationsApi.get`).
   */
  get(intentHash: string, scope?: TenantScope): Promise<FixationRecord | null>;
  /**
   * Self-healing invalidation of a stale fixation. The host calls this when materialize's revalidation
   * fails (stale). As with unfixate, the state change (deleteFixation) is done first, and only on success is the
   * audit event (intent.unfixated) recorded with actor {kind:"system"}. If deleteFixation is not implemented,
   * fail-fast (FixationUnsupportedError). options.tenant propagates to resolving the deletion target and to
   * the audit event. options.guard.ifCatalogFingerprint (optional): the catalog fingerprint of the fixation at the
   * time of the stale decision. If it does not match the current fixation (= a different fixation re-approved
   * after the decision), do not delete (TOCTOU guard).
   */
  invalidate(intentHash: string, reason: "stale", options?: InvalidateOptions): Promise<void>;
  /**
   * Re-stamp a fixation that passed revalidation with the current catalog fingerprint. Puts subsequent
   * checks on the fingerprint fast path. Only overwrites via putFixation and records no audit event (this
   * resolves state staleness, it is not a governance decision).
   */
  refreshFingerprint(intentHash: string, catalogFingerprint: string, scope?: TenantScope): Promise<void>;
  /**
   * Rewrites a fixation's pinnedSpec in place, for host-core's `applyCatalogMigration` (design.md #65). The
   * intentHash and tenant are unchanged (the fixation's identity); structureHash is recomputed from
   * `pinnedSpec` (never trusted from the caller, matching `fixate`'s own behavior), a fresh `revision` is
   * stamped, and the catalog fingerprint is re-stamped from `catalogFor` (same as `fixate`) so the fast path
   * reflects the post-migration catalog. Returns `null` without writing anything when the fixation is
   * absent or `options.guard` does not match the current record (TOCTOU: the plan was built against a
   * fixation that has since moved on — see `ReplaceOptions.guard`). On success, records `intent.migrated`
   * (actor: the approver) rather than `intent.fixated` — a distinct audit event so a migration-driven
   * rewrite is never conflated with a fresh human fixation.
   */
  replace(intentHash: string, pinnedSpec: UISpec, options: ReplaceOptions): Promise<FixationRecord | null>;
}

/**
 * L1 -> L0 fixation.
 * Applying the effect is handled by host-rest's fixationLookup short-circuit; the composer needs no changes.
 * Thanks to $ref reference-passing, even with the structure fixed the data is always the latest.
 */
export interface L1UsageAccumulator {
  canonical: string;
  params?: Record<string, unknown>;
  tier: string;
  uses: number;
  sessions: Set<string>;
  structures: Map<string, number>;
}

/**
 * Pure aggregation step of proposals(): folds view.composed events (L1 tier only, excluding intents already
 * fixated) into a per-intentHash accumulator of uses / distinct sessions / structure-hash counts. No I/O and
 * no policy dependency (thresholding happens in proposals() after this returns). Moved to module scope
 * (a God-factory split, step 3 of extracting fixation/service.ts) for direct unit testing, independent of createFixations' opts/policy.
 */
export function aggregateL1Usage(
  events: LineageEventRecord[],
  fixated: Set<string>,
): Map<string, L1UsageAccumulator> {
  const byIntent = new Map<string, L1UsageAccumulator>();
  for (const event of events) {
    const tier = String(event.payload["tier"] ?? "");
    // L2 is the promotion pipeline's domain, L0 is already fixated — only L1 is subject to fixation
    if (tier !== "L1") continue;
    const intentHash = String(event.payload["intentHash"] ?? "");
    if (intentHash === "" || fixated.has(intentHash)) continue;
    const acc = byIntent.get(intentHash) ?? {
      canonical: String(event.payload["canonical"] ?? ""),
      params: event.payload["params"] as Record<string, unknown> | undefined,
      tier,
      uses: 0,
      sessions: new Set<string>(),
      structures: new Map<string, number>(),
    };
    acc.uses++;
    if (typeof event.payload["sessionId"] === "string") acc.sessions.add(event.payload["sessionId"]);
    const structureHash = event.payload["structureHash"];
    if (typeof structureHash === "string") {
      acc.structures.set(structureHash, (acc.structures.get(structureHash) ?? 0) + 1);
    }
    byIntent.set(intentHash, acc);
  }
  return byIntent;
}

/**
 * Generates a coarse ulid-like, per-write revision token: a base36 ms timestamp plus a random suffix. Not the
 * full `ulid` library (no cross-service sortability guarantee is needed here) — only "distinguishable from the
 * previous write even inside the same millisecond" matters, which `fixatedAt` (an ms-precision ISO timestamp)
 * cannot provide (an unfixate → fixate pair landing in the same ms would otherwise share a TOCTOU guard
 * token with the fixation it replaced).
 */
function generateRevision(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createFixations(opts: {
  lineage: Lineage;
  storage: StoragePort;
  policy?: Partial<FixationPolicy>;
  /**
   * Source that supplies the catalog fingerprint to stamp at fixation time. At fixate, stamps the catalog
   * fingerprint of that tenant. Because promotion splits catalogs per tenant, it is resolved via the tenant
   * argument (the getter must always return the latest fingerprint). If omitted, no fingerprint is stamped =
   * always the revalidation path (legacy behavior).
   */
  catalogFor?: (tenant?: string) => { readonly fingerprint: string };
  /** Clock injection point (tests only; defaults to the real wall clock). */
  now?: () => Date;
  /**
   * Fail-open observability hook (product responsibility, optional): notified when a fixation record read
   * back from storage fails schema validation. See `FixationErrorEndpoint`'s doc. Fired
   * fire-and-forget (a throw/rejection from the hook itself is swallowed) — see `notifyFixationError`.
   */
  onError?: (ctx: FixationErrorContext, error: unknown) => void;
}): Fixations {
  const now = (): Date => opts.now?.() ?? new Date();
  const policy: FixationPolicy = { ...DEFAULT_FIXATION_POLICY, ...opts.policy };

  /**
   * Reads a fixation and validates it against FixationRecordSchema, treating a validation failure exactly
   * like a real absence (the caller's existing `if (existing == null) return;` branch already does the
   * right thing — no delivery, no state change, no audit). Shared by unfixate / invalidate /
   * refreshFingerprint, the three call sites that read a fixation back from storage in this service (the
   * delivery-path read, host.lookup -> composer.materializeFixation, is validated independently by the
   * composer, since it never routes through this service).
   */
  async function getValidatedFixation(
    intentHash: string,
    tenant: string | undefined,
  ): Promise<FixationRecord | null> {
    const raw = await opts.storage.getFixation(intentHash, tenant);
    if (raw == null) return null;
    const parsed = FixationRecordSchema.safeParse(raw);
    if (parsed.success) return parsed.data as FixationRecord;
    notifyFixationError(
      opts.onError,
      { endpoint: "storage.record.invalid", intentHash, ...tenantField(tenant) },
      parsed.error,
    );
    return null;
  }

  /**
   * Shared delete + audit for unfixate (human-approved) and invalidate (staleness self-healing, stale revalidation):
   * fail-fast if StoragePort.deleteFixation is unimplemented (FixationUnsupportedError) rather than silently
   * no-op'ing, since that would leave a permanent inconsistency between the recorded audit and actual state; then
   * delete the fixation (state change) first and record intent.unfixated (audit) only on success, so the event
   * log stays the source of truth. Callers own any pre-delete guard (e.g. invalidate's TOCTOU fingerprint check).
   */
  async function deleteFixationAndAudit(
    intentHash: string,
    tenant: string | undefined,
    payload: Record<string, unknown>,
    actor: ActorKind,
  ): Promise<void> {
    if (opts.storage.deleteFixation == null) {
      throw new FixationUnsupportedError();
    }
    // Do the state change (deletion) first, and record the audit event only on success.
    await opts.storage.deleteFixation(intentHash, tenant);
    await opts.lineage.record("intent.unfixated", payload, actor, tenant);
  }

  /**
   * The fields (re)stamped whenever a pinnedSpec is written, shared by fixate and replace: the recomputed
   * structureHash (never trusted from the caller), the pinnedSpec itself, a fresh fixatedAt / revision, the
   * approver, and this tenant's catalog fingerprint (the fast-path basis for materialize's staleness
   * detection) when a catalog source is configured.
   */
  async function stampPinned(pinnedSpec: UISpec, approver: Principal, tenant: string | undefined) {
    return {
      structureHash: await computeStructureHash(pinnedSpec),
      pinnedSpec,
      fixatedAt: now().toISOString(),
      revision: generateRevision(),
      approver,
      ...(opts.catalogFor != null ? { catalogFingerprint: opts.catalogFor(tenant).fingerprint } : {}),
    };
  }

  return {
    async proposals(scope?: TenantScope) {
      // Aggregation covers only the most recent FIXATION_PROPOSAL_SCAN_WINDOW view.composed events. Anything beyond is dropped.
      // In the future, move toward a since window or an aggregate query (DB backend).
      // When tenant is given, aggregate only that tenant's view.composed / fixations.
      const composed = await opts.storage.listLineage({
        type: ["view.composed"],
        limit: FIXATION_PROPOSAL_SCAN_WINDOW,
        ...tenantField(scope?.tenant),
      });
      const fixated = new Set((await opts.storage.listFixations(scope?.tenant)).map((f) => f.intentHash));

      const byIntent = aggregateL1Usage(composed, fixated);

      const proposals: FixationProposal[] = [];
      for (const [intentHash, acc] of byIntent) {
        const structureCounts = [...acc.structures.values()];
        const total = structureCounts.reduce((a, b) => a + b, 0);
        const stability = total > 0 ? Math.max(...structureCounts) / total : 1;
        const sessions = Math.max(acc.sessions.size, acc.uses > 0 ? 1 : 0);
        if (
          acc.uses >= policy.minUses &&
          sessions >= policy.minDistinctSessions &&
          stability >= policy.structuralStability
        ) {
          proposals.push({
            intentHash,
            canonical: acc.canonical,
            ...(acc.params != null ? { params: acc.params } : {}),
            uses: acc.uses,
            sessions,
            stability: Math.round(stability * 1000) / 1000,
            tier: acc.tier,
          });
        }
      }
      return proposals.sort((a, b) => b.uses - a.uses);
    },

    async list(scope?: TenantScope) {
      return opts.storage.listFixations(scope?.tenant);
    },

    async get(intentHash: string, scope?: TenantScope) {
      return getValidatedFixation(intentHash, scope?.tenant);
    },

    async fixate({ pinnedSpec, approver, tenant }) {
      const fallback = pinnedSpec.provenance.fallback;
      if (fallback != null) {
        throw new FixationNotAllowedError(
          "fallback",
          `a Spec carrying provenance.fallback cannot be fixated (${fallback.reason})`,
        );
      }
      if (pinnedSpec.provenance.tier === "L2") {
        throw new FixationNotAllowedError(
          "l2-tier",
          "an L2 free-form Spec cannot be fixated; L2 results are governed by the promotion pipeline (L2->L1)",
        );
      }
      const record: FixationRecord = {
        intentHash: pinnedSpec.intent.hash,
        canonical: pinnedSpec.intent.canonical,
        ...(await stampPinned(pinnedSpec, approver, tenant)),
        // Stamp the tenant (the basis on which the StoragePort key-separates by (tenant, intentHash)).
        ...tenantField(tenant),
      };
      await opts.storage.putFixation(record);
      await opts.lineage.record(
        "intent.fixated",
        {
          intentHash: record.intentHash,
          canonical: record.canonical,
          structureHash: record.structureHash,
          approver: approver.id,
        },
        { kind: "user", id: approver.id },
        tenant,
      );
      return record;
    },

    async unfixate(intentHash, approver, scope) {
      const tenant = scope?.tenant;
      const existing = await getValidatedFixation(intentHash, tenant);
      if (existing == null) return;
      await deleteFixationAndAudit(
        intentHash,
        tenant,
        { intentHash, approver: approver.id },
        { kind: "user", id: approver.id },
      );
    },

    async invalidate(intentHash, reason, options) {
      const { detail, tenant, guard } = options ?? {};
      const existing = await getValidatedFixation(intentHash, tenant);
      if (existing == null) return;
      // TOCTOU guard: if the fixation at the time of the stale decision (guard.ifCatalogFingerprint /
      // guard.ifRevision / guard.ifFixatedAt) and the current fixation are different (re-approved after the
      // decision), do not delete (see guardMatches).
      if (!guardMatches(existing, guard)) return;
      // Since this is self-healing invalidation, the actor is system (distinguished from human-approved unfixate).
      await deleteFixationAndAudit(
        intentHash,
        tenant,
        { intentHash, reason, ...(detail != null ? { detail } : {}) },
        { kind: "system" },
      );
    },

    async refreshFingerprint(intentHash, catalogFingerprint, scope) {
      const existing = await getValidatedFixation(intentHash, scope?.tenant);
      if (existing == null) return;
      // Only re-stamps the fingerprint. Not a governance decision, so no audit event is recorded.
      // It overwrites while preserving existing.tenant, so putFixation writes back to the same key.
      // { ifPresent: true }: self-healing fires fire-and-forget from the compose path, so between this
      // call's get and put another writer (a management-plane unfixate, or the same race on another host
      // process sharing storage) may have deleted the fixation. Without a conditional write, put would
      // resurrect it from this stale in-memory copy; ifPresent makes the write a no-op unless the fixation
      // still exists on disk (a StoragePort that ignores the option keeps the old unconditional-write
      // behavior, so this is a strict hardening, not a required contract change).
      await opts.storage.putFixation({ ...existing, catalogFingerprint }, { ifPresent: true });
    },

    async replace(intentHash, pinnedSpec, options) {
      const { approver, tenant, guard, planId } = options;
      const existing = await getValidatedFixation(intentHash, tenant);
      if (existing == null) return null;
      // Same TOCTOU shape as invalidate's guard, plus ifStructureHash (see ReplaceOptions.guard's doc).
      if (!guardMatches(existing, guard)) return null;
      if (guard?.ifStructureHash != null && existing.structureHash !== guard.ifStructureHash) {
        return null;
      }
      const record: FixationRecord = {
        ...existing,
        ...(await stampPinned(pinnedSpec, approver, tenant)),
      };
      // ifPresent: true guards the same race refreshFingerprint's own write does (a concurrent unfixate
      // between this function's get and put must not resurrect the fixation from this stale in-memory copy).
      await opts.storage.putFixation(record, { ifPresent: true });
      await opts.lineage.record(
        "intent.migrated",
        {
          intentHash,
          structureHash: record.structureHash,
          approver: approver.id,
          ...(planId != null ? { planId } : {}),
        },
        { kind: "user", id: approver.id },
        tenant,
      );
      return record;
    },
  };
}
