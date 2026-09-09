import type { Judge } from "@kohaku-ui/evals";
import { createPromotions, type Lineage, type Promotions } from "@kohaku-ui/lineage";
import type { StoragePort } from "@kohaku-ui/spec-core";
import { type PromotedRegistry, toPromotedEntry } from "../intents/promoted-registry.js";

/**
 * Nomination threshold for promotion candidates (uses >= this many times before a candidate is offered for
 * review). A low value for the demo (production default is uses>=20). Exported so app.ts can bundle it into
 * GET /analytics/summary's `promotionPolicy` — the single source sample-web's i18n copy (ui.ts's
 * `admin.promotions.emptyAll`) reads the number from, instead of duplicating it as a string literal.
 */
export const PROMOTION_MIN_USES = 2;

/**
 * Assembles the promotion pipeline (telemetry aggregation + createPromotions).
 * lineage / storage / registry / judge receive the caller's shared instances and are not regenerated internally.
 */
export function createPromotionPipeline(args: {
  lineage: Lineage;
  storage: StoragePort;
  registry: PromotedRegistry;
  judge: Judge;
}): Promotions {
  const { lineage, storage, registry, judge } = args;

  // Runtime telemetry aggregation: aggregates component.used via telemetry (source:"telemetry") as input for the
  // judge's decision. An observation of "real-render reliability" on a separate axis from the promotion aggregation uses
  // (where the compose record is authoritative). Narrows listLineage by tenant: since artifactId is content-sha256-derived
  // and unique across tenants, the aggregation is limited to the given tenant so that another tenant's telemetry using
  // the same artifactId does not pollute the judge input.
  // tenant is the value passed to approve, propagated via the PromotionJudge's context (unspecified = single tenant is all).
  async function telemetryFor(
    artifactId: string,
    tenant?: string,
  ): Promise<{ renderedCount: number; errorCount: number }> {
    // limit 10_000 is the aggregation-window cap. A silent cap that drops older telemetry beyond it (the same
    // "has a window cap" constraint as /analytics's truncated discipline; strict full-volume aggregation is the DB backend's responsibility).
    const used = await storage.listLineage({
      type: ["component.used"],
      artifactId,
      limit: 10_000,
      ...(tenant != null ? { tenant } : {}),
    });
    const observed = used.filter((e) => e.payload["source"] === "telemetry");
    const errorCount = observed.filter((e) => e.payload["outcome"] === "error").length;
    return { renderedCount: observed.length, errorCount };
  }

  return createPromotions({
    lineage,
    storage,
    // A low threshold for the demo (the production default is uses>=20, sessions>=5). The judge is treated as advisory.
    policy: { minUses: PROMOTION_MIN_USES, minDistinctSessions: 1, judgeBlocking: false },
    // Promotion review (LLM-as-Judge). Called from promotions in the candidate state of the approve path.
    // context.tenant is the tenant passed to approve. Used to narrow the telemetry aggregation to that tenant.
    judge: async (candidate, context) => {
      const telemetry = await telemetryFor(candidate.artifactId, context?.tenant);
      const result = await judge.judge({
        kind: "l2-component",
        html: candidate.html ?? "",
        request: candidate.request ?? "",
        usage: { uses: candidate.uses, sessions: candidate.sessions },
        // Transcribe only when there is a real-render observation (with 0 observations, do not put it in the prompt).
        ...(telemetry.renderedCount > 0 ? { telemetry } : {}),
      });
      // Return the rubric version and summary to the verdict, stamping "which version judged how" into component.judged.
      return {
        pass: result.pass,
        score: result.score,
        reason: result.summary,
        rubricId: result.rubricId,
        rubricVersion: result.rubricVersion,
      };
    },
    // The pre-check gate for publish: detects name / componentType collisions before the snapshot transition.
    // Throwing here means the snapshot does not transition to published and the projection (onPublish) is never reached.
    // The check is done against the given tenant's catalog / Intents (independent per tenant).
    validatePublish: async ({ artifactId, draft, html, tenant }) => {
      registry.validatePublish(
        tenant,
        toPromotedEntry({ artifactId, draft, html, publishedAt: new Date().toISOString() }),
      );
    },
    // Projection application of publish (idempotent). Called in the order snapshot authority -> projection, and since
    // startup reconcile re-applies, an already-registered entry is a no-op. Reflected into the per-tenant registry.
    // Persistence is handled by the snapshot (promotions.json), so no write to promoted.json is done.
    onPublish: async ({ artifactId, draft, html, request, tenant }) => {
      registry.publish(
        tenant,
        toPromotedEntry({
          artifactId,
          draft,
          html,
          ...(request != null ? { request } : {}),
          publishedAt: new Date().toISOString(),
        }),
      );
    },
    // Symmetric with onPublish. On withdrawal from published (unpublish), removes it from the given tenant's catalog / Intents.
    // Since the catalog fingerprint changes, existing Spec caches containing the promoted component are "made unreachable"
    // rather than "deleted" (cache consistency is kept with no explicit evict needed).
    onUnpublish: async ({ artifactId, tenant }) => {
      registry.unpublish(tenant, artifactId);
    },
    // Observability of the (fail-open) component.published audit-record path (the demo is console-based, same
    // convention as compose-context.ts's observer.onError / host-deps.ts's onError). Fires when the audit
    // record fails either at publish time or during a reconcile backfill attempt; the projection itself is
    // never blocked by this (see createPromotions' handlePublish / reconcile docs).
    onError: ({ endpoint, artifactId, tenant }, error) => {
      console.error(
        `[promotions] failed to record the ${endpoint} audit event for ${artifactId}${tenant != null ? ` (tenant=${tenant})` : ""}:`,
        error,
      );
    },
  });
}
