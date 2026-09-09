import type { StoragePort } from "@kohaku-ui/spec-core";
import { NOMINATED_SCAN_WINDOW } from "../constants.js";
import type { Lineage } from "../lineage.js";
import { tenantField } from "../tenant-scope.js";
import { transition } from "./machine.js";
import {
  notifyPromotionError,
  type PromotionCandidate,
  type PromotionErrorContext,
  type PromotionPolicy,
} from "./service.js";

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
  const { storage, lineage, policy, persistMany, onError } = opts;

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
      if (typeof artifactId === "string") nominatedIds.add(artifactId);
    }
    const toPersist: { candidate: PromotionCandidate; tenant?: string }[] = [];
    for (const { candidate, tenant: recordTenant } of candidates) {
      // AUTO: on threshold satisfaction, in_use -> candidate (nomination by policy). Already-nominated ones are not re-recorded.
      if (
        candidate.status === "in_use" &&
        !nominatedIds.has(candidate.artifactId) &&
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
        nominatedIds.add(candidate.artifactId);
      }
    }
    await persistMany(toPersist);
    // Stamp each nominate event with tenant too (so re-evaluation in the tenant scope finds the same
    // nominated and becomes idempotent). Recorded only after the batch persist above resolves.
    for (const { candidate } of toPersist) {
      await lineage.record(
        "component.nominated",
        { artifactId: candidate.artifactId, by: "policy" },
        undefined,
        tenant,
      );
    }
    return candidates.map((c) => c.candidate);
  }

  return { nominateEligible };
}
