import type { StoragePort } from "@kohaku-ui/spec-core";
import { NOMINATED_SCAN_WINDOW } from "../constants.js";
import type { Lineage } from "../lineage.js";
import { type TenantScope, tenantField } from "../tenant-scope.js";
import { recordFailOpen } from "./audit.js";
import { mapWithConcurrency } from "./concurrency.js";
import { transition } from "./machine.js";
import {
  notifyPromotionError,
  type PromotionCandidate,
  type PromotionErrorContext,
  type PromotionPolicy,
} from "./service.js";
import type { SchemaSuggestion } from "./suggestion.js";
import { usageIndexKey } from "./usage.js";

/**
 * Nomination step of the promotion pipeline, split out of createPromotions (a God-factory split).
 * Owns the sole side-effecting "in_use -> candidate by policy" transition and its
 * component.nominated audit, layered on top of the candidate-store's `persist` (promotion/candidate-store.ts).
 */
export function createNomination(opts: {
  storage: StoragePort;
  lineage: Lineage;
  policy: PromotionPolicy;
  /**
   * Batch persist (candidate-store's `persistMany`), so a scan that nominates many candidates in one pass
   * issues a single storage read-modify-write instead of one per nominated candidate.
   */
  persistMany: (items: { candidate: PromotionCandidate; tenant?: string }[]) => Promise<void>;
  onError?: (ctx: PromotionErrorContext, error: unknown) => void;
  /**
   * Optional schema extraction hook (see createPromotions' own doc for the full advisory / fail-open
   * contract). Forwarded verbatim from createPromotions' opts.
   */
  suggestSchema?: (candidate: PromotionCandidate, context?: TenantScope) => Promise<SchemaSuggestion | null>;
  /**
   * Extraction concurrency budget (#15): at most this many `suggestSchema` calls run in flight at once across a
   * single scan's freshly nominated candidates (a worker pool via `mapWithConcurrency`, not unbounded
   * `Promise.all`). Resolved from `createPromotions`' own `suggestConcurrency` opt (default 4) and always a
   * concrete number by the time it reaches here — see createPromotions' own doc for the latency-cost rationale
   * this bounds (the tenant's promotion lock is held for as long as the slowest in-flight batch takes).
   */
  suggestConcurrency: number;
}): {
  /**
   * `candidates` pairs each candidate with its own owning tenant (candidate-store's `scanWithTenant`), needed by
   * the tenant-mismatch guard below (#10).
   */
  nominateEligible(
    candidates: { candidate: PromotionCandidate; tenant?: string }[],
    tenant?: string,
  ): Promise<PromotionCandidate[]>;
} {
  const { storage, lineage, policy, persistMany, onError, suggestSchema, suggestConcurrency } = opts;

  /**
   * Side-effecting nominate step: for candidates still in_use that satisfy the policy thresholds and are not
   * already nominated (idempotency guard via the component.nominated event log — because list fetches can be
   * called concurrently/repeatedly in GET fashion, the event log rather than status persistence alone is the
   * source of truth that prevents double-recording), transitions in_use -> candidate, persists, and records
   * component.nominated. Mutates the given candidates' status in place and returns them unwrapped.
   *
   * Every eligible candidate's status transition is applied in memory first, then persisted with a **single**
   * `persistMany` call at the end instead of one storage write per candidate — a scan that nominates many
   * candidates at once (e.g. after a burst of usage) no longer re-reads/re-stringifies/re-writes promotions.json
   * once per candidate. component.nominated audit events are recorded only after persistMany resolves, so a
   * persist failure leaves neither the snapshot nor the audit log reflecting the (uncommitted) transition.
   *
   * Tenant-mismatch guard (#10): `tenant` is the call-level scope passed to `evaluateAndList` (undefined = an
   * all-tenant scan). When it is unspecified but a scanned candidate's own recorded tenant is not (a
   * tenant-tagged record surfaced by an all-tenant scan), persisting that candidate under the tenant-neutral
   * scope would create/overwrite a tenant-neutral promotion state for an artifact that actually belongs to one
   * tenant — silently mixing single-tenant and multi-tenant governance state. Such a candidate is skipped
   * (left in_use, un-nominated) and reported via onError instead. Single-tenant operation (no record ever
   * carries a tenant) never triggers this: every candidate's own tenant is then also undefined.
   *
   * Tenant-keyed idempotency guard: `nominatedIds` is keyed by `usageIndexKey(event's own tenant, artifactId)`,
   * not by artifactId alone — artifactId derives from content sha256 and is globally unique, so the *same*
   * artifactId can be independently nominated by multiple tenants (mirrors candidate-store.ts's
   * `scanCandidatesWithTenant` and usage.ts's own composite key). Keying by artifactId alone (as this used to)
   * would, on an all-tenant scan (`tenant` unspecified), let one tenant's prior `component.nominated` event
   * suppress another tenant's own eligible in_use candidate for the same artifactId — a silent no-op that never
   * transitions it to `candidate`.
   *
   * The `component.nominated` audit record is fail-open, mirroring `handlePublish`'s own audit record: the
   * status transition is already durable (persisted via `persistMany` above) before this loop runs, so a
   * storage hiccup recording the audit event must not stop the batch (or leave a persisted-but-unaudited
   * candidate silently swallowed along with every candidate still queued after it) — the failure is instead
   * reported per-candidate via `onError({ endpoint: "promotion.nominate.audit" })`. There is currently no
   * reconcile-style backfill for a missed `component.nominated` event (unlike publish/unpublish's audit,
   * reconcile does not scan `in_use`/`candidate` snapshots), so a failure here leaves that one nominate
   * permanently unaudited even though the candidate is now persisted as `candidate` — the audit trail is
   * incomplete for that artifact, but the promotion pipeline itself is unaffected (a status-only fact this
   * nominate produced, not paired with an artifact-visible side effect like onPublish's projection).
   */
  async function nominateEligible(
    candidates: { candidate: PromotionCandidate; tenant?: string }[],
    tenant?: string,
  ): Promise<PromotionCandidate[]> {
    const nominatedEvents = await storage.listLineage({
      type: ["component.nominated"],
      limit: NOMINATED_SCAN_WINDOW,
      ...tenantField(tenant),
    });
    const nominatedIds = new Set<string>();
    for (const e of nominatedEvents) {
      const artifactId = e.payload["artifactId"];
      if (typeof artifactId === "string") nominatedIds.add(usageIndexKey(e.tenant, artifactId));
    }
    const toPersist: { candidate: PromotionCandidate; tenant?: string }[] = [];
    for (const { candidate, tenant: recordTenant } of candidates) {
      // AUTO: on threshold satisfaction, in_use -> candidate (nomination by policy). Already-nominated ones are not re-recorded.
      if (
        candidate.status === "in_use" &&
        !nominatedIds.has(usageIndexKey(recordTenant, candidate.artifactId)) &&
        candidate.uses >= policy.minUses &&
        candidate.sessions >= policy.minDistinctSessions
      ) {
        if (tenant == null && recordTenant != null) {
          notifyPromotionError(
            onError,
            { endpoint: "promotion.nominate.tenant", artifactId: candidate.artifactId, tenant: recordTenant },
            new Error(
              `skipped auto-nomination for artifact ${candidate.artifactId}: evaluateAndList was called with no tenant scope, but this candidate belongs to tenant "${recordTenant}"`,
            ),
          );
          continue;
        }
        candidate.status = transition(candidate.status, { kind: "nominate", by: "policy" }, policy);
        toPersist.push({ candidate, tenant });
        nominatedIds.add(usageIndexKey(recordTenant, candidate.artifactId));
      }
    }
    // Advisory schema extraction (fail-open), run with up to `suggestConcurrency` in flight at once across
    // this scan's freshly nominated candidates rather than fully sequentially: this whole call runs inside the
    // tenant's promotion governance mutex (host-rest's withPromotionLock), so N sequential LLM calls would hold
    // that lock for N x the extractor's own latency, queuing every other promotion transition for the tenant
    // behind it. Bounded rather than fully unbounded (#15): an unbounded Promise.all across a whole burst of
    // newly nominated candidates would fire all of them as simultaneous LLM calls at once, amplifying both the
    // provider's own rate limits and how long this lock stays held by whichever call is slowest in an
    // arbitrarily large batch; mapWithConcurrency caps how many ever run at once. Still runs before persistMany
    // so every suggestion lands in the same snapshot write as its candidate's status transition (each call
    // mutates its own `candidate` object in place; toPersist already holds those references). A throw from one
    // candidate's extraction is caught by suggestFailOpen and does not affect the others (suggestFailOpen never
    // rejects, so one slow/failing candidate cannot stall the worker pool from picking up the next item).
    if (suggestSchema != null) {
      await mapWithConcurrency(toPersist, suggestConcurrency, async ({ candidate }) => {
        const suggestion = await suggestFailOpen(candidate, tenant);
        if (suggestion != null) candidate.suggestion = suggestion;
      });
    }
    await persistMany(toPersist);
    // Stamp each nominate event with tenant too (so re-evaluation in the tenant scope finds the same
    // nominated and becomes idempotent). Recorded only after the batch persist above resolves. Fail-open (see
    // this function's doc): a record failure here must not stop auditing the remaining candidates in the batch,
    // nor undo the already-persisted status transition (the candidate's snapshot has a draft-free `candidate`
    // status either way, whether or not the audit record actually landed).
    for (const { candidate } of toPersist) {
      await recordFailOpen(
        lineage,
        onError,
        "promotion.nominate.audit",
        "component.nominated",
        { artifactId: candidate.artifactId, by: "policy" },
        undefined,
        { tenant, artifactId: candidate.artifactId },
      );
    }
    // Audit the advisory suggestion (if any), after component.nominated -- symmetric fail-open discipline: a
    // storage hiccup here must not undo the already-persisted suggestion or stop auditing the rest of the batch.
    for (const { candidate } of toPersist) {
      if (candidate.suggestion == null) continue;
      await recordFailOpen(
        lineage,
        onError,
        "promotion.suggest.audit",
        "component.schemaSuggested",
        { artifactId: candidate.artifactId, suggestion: candidate.suggestion },
        { kind: "model" },
        { tenant, artifactId: candidate.artifactId },
      );
    }
    return candidates.map((c) => c.candidate);
  }

  /**
   * Fail-open wrapper around the optional `suggestSchema` hook: a throw / rejection is reported via
   * `onError({ endpoint: "promotion.suggest.schema" })` and treated as "no suggestion" (undefined), matching
   * `null`'s own "no proposal" meaning from the hook's own contract.
   */
  async function suggestFailOpen(
    candidate: PromotionCandidate,
    tenant: string | undefined,
  ): Promise<SchemaSuggestion | undefined> {
    try {
      return (await suggestSchema!(candidate, tenantField(tenant))) ?? undefined;
    } catch (error) {
      notifyPromotionError(
        onError,
        { endpoint: "promotion.suggest.schema", artifactId: candidate.artifactId, ...tenantField(tenant) },
        error,
      );
      return undefined;
    }
  }

  return { nominateEligible };
}
