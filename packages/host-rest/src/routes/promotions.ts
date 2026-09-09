import { DEFAULT_CAPABILITY_TTL_SECONDS } from "@kohaku-ui/host-core";
import { type ErrorEnvelope, GOVERNANCE_ERROR_DISCRIMINATORS, type Principal } from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { errorBody } from "../errors.js";
import type { GovernanceOperation, GovernanceOperationKind } from "../governance-policy.js";
import type { KohakuHostDeps, PromotionsApi } from "../types.js";
import { ComponentDraftSchema, PromotionActionSchema } from "./schemas.js";
import {
  message,
  parseBody,
  type RouteContext,
  reportHostError,
  requestIdOf,
  resolveTenant,
  tenantScope,
  tenantScopeOf,
} from "./shared.js";

/**
 * The client-visible message for an unexpected promotion-transition failure (INTERNAL 500). An arbitrary
 * exception may carry internals unsafe to echo back; the original error still reaches the observability hook
 * (onError) via reportHostError, so nothing is lost for diagnosis. The typed/expected failure branches above
 * (PROMOTION_NOT_PUBLISHED / PROMOTION_INVALID / NOT_FOUND) keep their own message — only this catch-all does not.
 */
const PROMOTION_INTERNAL_ERROR_MESSAGE =
  "promotion transition failed; see the observability hook (onError) for details";

/**
 * Injects the server-side principal into a validated action (does not accept a client-declared reviewer/by).
 * nominate sets the session principal on `by`; review.* sets it on `reviewer`.
 */
function withPrincipal(
  action: z.infer<typeof PromotionActionSchema>,
  principal: Principal,
): Record<string, unknown> {
  switch (action.kind) {
    case "nominate":
      return { ...action, by: principal };
    case "review.approve":
    case "review.requestChanges":
    case "review.reject":
      return { ...action, reviewer: principal };
    default:
      return { ...action };
  }
}

/**
 * Additional governance kind the generic action route (POST /promotions/:artifactId/actions) requires on top
 * of the route's blanket `promotion.act` check, keyed by `action.kind`. Without this, a role holding only
 * `promotion.act` could reach `judge.result` (spoofing the judge verdict), `review.approve`/`publish`/
 * `schema.propose`, or `withdraw`/`unpublish` through the generic route even though the dedicated named
 * routes (/approve, /reject, /withdraw) gate the same transitions behind their own kinds. `undefined` means no
 * additional kind is required beyond `promotion.act` (nominate / judge.start / review.start /
 * review.requestChanges have no dedicated named route to mirror).
 */
function extraGovernanceKindFor(
  kind: z.infer<typeof PromotionActionSchema>["kind"],
): GovernanceOperationKind | undefined {
  switch (kind) {
    case "review.approve":
    case "publish":
    case "schema.propose":
      return "promotion.approve";
    case "review.reject":
      return "promotion.reject";
    case "withdraw":
    case "unpublish":
      return "promotion.withdraw";
    case "judge.result":
      return "promotion.judge";
    case "nominate":
    case "judge.start":
    case "review.start":
    case "review.requestChanges":
      return undefined;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** Management plane of the promotion pipeline (L2->L1) (the 8 /promotions routes). */
export function registerPromotionRoutes(app: Hono, ctx: RouteContext): void {
  const { deps, getPrincipal, requireGovernance, withPromotionLock } = ctx;

  /**
   * Shared skeleton for promotion transition routes (approve / reject / withdraw / actions). The check order
   * is unchanged: unwired 501 -> governance authorization -> principal / tenant resolution -> body validation
   * (prepare) -> artifact existence (owning-tenant) check -> execute the transition under the promotion lock
   * (per-tenant serialization, preventing interleaving of concurrent approves, double onPublish firing, and
   * lost updates) -> promotionError mapping.
   * prepare validates the body and, if invalid, returns a 400 response (each route owns its message); if valid, it
   * returns a thunk that executes the transition (running inside withPromotionLock).
   */
  const promotionTransition = async (
    c: Context,
    kind: GovernanceOperation["kind"],
    prepare: (transitionCtx: {
      promotions: PromotionsApi;
      artifactId: string;
      principal: Principal;
      tenant: string | undefined;
      scope: { tenant?: string } | undefined;
    }) => Promise<Response | (() => Promise<unknown>)>,
  ): Promise<Response> => {
    if (deps.promotions == null) return promotionsNotConfigured(c);
    const promotions = deps.promotions;
    // Exclusive to /promotions/:artifactId/* routes (the generic Context type makes param string | undefined).
    const artifactId = c.req.param("artifactId")!;
    const denied = await requireGovernance(c, { kind, artifactId });
    if (denied != null) return denied;
    const principal = await getPrincipal(c);
    const tenant = await resolveTenant(c, deps);
    const scope = tenantScopeOf(tenant);
    const transition = await prepare({ promotions, artifactId, principal, tenant, scope });
    if (transition instanceof Response) return transition;
    const notFound = await ensureArtifact(c, promotions, artifactId, scope);
    if (notFound != null) return notFound;
    try {
      const candidate = await withPromotionLock(tenant, transition);
      return c.json({ candidate });
    } catch (e) {
      return promotionError(c, deps, kind, e);
    }
  };

  // GET is read-only (with list, no auto-nominate side effect; without it, fall back to the old behavior).
  // The auto-candidacy side effect (usage-log threshold -> candidate) is split off to POST /promotions/evaluate.
  app.get("/promotions", async (c) => {
    if (deps.promotions == null) return promotionsNotConfigured(c);
    const promotions = deps.promotions;
    const denied = await requireGovernance(c, { kind: "promotion.list" });
    if (denied != null) return denied;
    // The management-plane tenant comes from the session (deps.tenant) rather than the query (mix-up prevention).
    const scope = await tenantScope(c, deps);
    // For a PromotionsApi without a list implementation, this degrades to evaluateAndList (which includes the
    // read-modify-write of auto-nominate), so serialize it under the same promotion lock as the act-family
    // (prevents lost updates from interleaving with approve).
    const listCandidates = (): Promise<unknown> =>
      promotions.list != null
        ? promotions.list(scope)
        : withPromotionLock(scope?.tenant, () => promotions.evaluateAndList(scope));
    // status filter. An empty string is treated as unspecified. Authorization stays promotion.list (read-only).
    const status = c.req.query("status");
    if (status != null && status !== "") {
      // If listByStatus exists, query the state index (a snapshot projection, avoiding a full scan of all generated).
      // For an unsupported PromotionsApi, filter the list/evaluateAndList result by status on the client side for compatibility.
      const candidates =
        promotions.listByStatus != null
          ? await promotions.listByStatus(status, scope)
          : ((await listCandidates()) as { status?: string }[]).filter(
              (candidate) => candidate.status === status,
            );
      return c.json({ candidates });
    }
    return c.json({ candidates: await listCandidates() });
  });

  // Operator escape hatch (#11): force the projection recovery from snapshot authority on demand, the same
  // recovery `reconcile` already runs at startup. Not scoped to one artifact or one tenant (it scans across
  // every tenant), so it does not go through `promotionTransition`'s per-:artifactId skeleton (no artifactId
  // param, no ensureArtifact pre-check) — instead it is serialized under the promotion lock's tenant-neutral
  // bucket (`withPromotionLock(undefined, …)`), the same bucket approve/reject/withdraw/actions/evaluate use for
  // an unscoped call, so it cannot race a concurrent transition's read-modify-write.
  app.post("/promotions/reconcile", async (c) => {
    if (deps.promotions == null) return promotionsNotConfigured(c);
    const promotions = deps.promotions;
    const denied = await requireGovernance(c, { kind: "promotion.reconcile" });
    if (denied != null) return denied;
    if (promotions.reconcile == null) {
      return c.json(errorBody("NOT_IMPLEMENTED", "promotions.reconcile is not implemented"), 501);
    }
    try {
      const summary = await withPromotionLock(undefined, () => promotions.reconcile!());
      return c.json({ summary });
    } catch (e) {
      return promotionError(c, deps, "promotion.reconcile", e);
    }
  });

  app.post("/promotions/evaluate", async (c) => {
    if (deps.promotions == null) return promotionsNotConfigured(c);
    const promotions = deps.promotions;
    const denied = await requireGovernance(c, { kind: "promotion.evaluate" });
    if (denied != null) return denied;
    // evaluateAndList includes the read-modify-write of auto-nominate (load -> transition -> persist), so serialize
    // it under the same promotion lock as the act-family. Outside the lock, a concurrent approve
    // that advanced the state could be overwritten from a stale snapshot (lost update).
    const scope = await tenantScope(c, deps);
    return c.json({
      candidates: await withPromotionLock(scope?.tenant, () => promotions.evaluateAndList(scope)),
    });
  });

  app.get("/promotions/:artifactId", async (c) => {
    if (deps.promotions == null) return promotionsNotConfigured(c);
    const denied = await requireGovernance(c, {
      kind: "promotion.get",
      artifactId: c.req.param("artifactId"),
    });
    if (denied != null) return denied;
    const loaded = await loadCandidateOrRespond(c, deps, c.req.param("artifactId"));
    if (loaded instanceof Response) return loaded;
    return c.json({ candidate: loaded });
  });

  // Preview: returns the material to re-mount the review target itself (the recorded artifact).
  // It does not re-compose — if the LLM regenerated different content on a cache miss, it would show "something
  // different from what was approved", so the html/sha256/ref retained in component.generated is the source of
  // truth (sha256 guarantees identity).
  // If a ref exists, issue a read capability scoped to just that single reference (POST because it mints a new token).
  // Authorization is the dedicated promotion.preview — a separate permission from viewing (promotion.get), so that
  // issuing data-read rights is not opened to the viewer role.
  app.post("/promotions/:artifactId/preview", async (c) => {
    if (deps.promotions == null) return promotionsNotConfigured(c);
    const denied = await requireGovernance(c, {
      kind: "promotion.preview",
      artifactId: c.req.param("artifactId"),
    });
    if (denied != null) return denied;
    const loaded = await loadCandidateOrRespond(c, deps, c.req.param("artifactId"));
    if (loaded instanceof Response) return loaded;
    const candidate = loaded as { html?: string; sha256?: string; ref?: string };
    if (candidate.html == null || candidate.sha256 == null) {
      return c.json(errorBody("NOT_FOUND", "no previewable artifact (html/sha256) is recorded"), 404);
    }
    // Paired with the sandbox bridge's allowlist (exact match on data.$ref), issue exactly one read scope.
    // No write scope is included (preview is read-only).
    const capability =
      candidate.ref != null
        ? await deps.authz.issueCapability(await getPrincipal(c), [{ kind: "read", ref: candidate.ref }], {
            ttlSeconds: deps.capabilityTtlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS,
          })
        : undefined;
    return c.json({
      preview: {
        html: candidate.html,
        sha256: candidate.sha256,
        ...(candidate.ref != null && capability != null ? { ref: candidate.ref, capability } : {}),
      },
    });
  });

  // "Approve and register": the bundle of judge -> human approval -> schema finalization -> publish (the reviewer is the server-side principal).
  app.post("/promotions/:artifactId/approve", (c) =>
    promotionTransition(c, "promotion.approve", async ({ promotions, artifactId, principal, scope }) => {
      const body = await parseBody(
        c,
        z.object({ draft: ComponentDraftSchema }),
        "draft (componentType / version / intentName / description) is required",
      );
      if (body instanceof Response) return body;
      return () => promotions.approve(artifactId, body.draft, principal, scope);
    }),
  );

  app.post("/promotions/:artifactId/reject", (c) =>
    promotionTransition(c, "promotion.reject", async ({ promotions, artifactId, principal, scope }) => {
      return () => promotions.reject(artifactId, principal, scope);
    }),
  );

  // Withdraw: if published, unpublish (published->withdrawn); if non-terminal, withdraw.
  app.post("/promotions/:artifactId/withdraw", (c) =>
    promotionTransition(c, "promotion.withdraw", async ({ promotions, artifactId, principal, scope }) => {
      // An empty body is treated as {} (reason is optional). Applying a default for nullish is left to the caller.
      const body = await parseBody(
        c,
        z.object({ reason: z.string().optional() }),
        "reason must be a string",
        { nullishFallback: {} },
      );
      if (body instanceof Response) return body;
      return () => promotions.withdraw(artifactId, principal, { reason: body.reason, ...scope });
    }),
  );

  // Generic action (validation-hardened). Accepts any single transition via PromotionActionSchema.
  // Kind-scoped authorization: beyond the blanket promotion.act check above, an action whose kind mirrors a
  // dedicated named route (review.approve/publish/schema.propose, review.reject, withdraw/unpublish) or that
  // records a judge verdict (judge.result) requires the matching additional governance kind, so holding only
  // promotion.act cannot bypass what the dedicated routes gate.
  app.post("/promotions/:artifactId/actions", (c) =>
    promotionTransition(c, "promotion.act", async ({ promotions, artifactId, principal, scope }) => {
      const raw = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
      const parsed = PromotionActionSchema.safeParse(raw?.action);
      if (!parsed.success) return c.json(errorBody("BAD_REQUEST", "action.kind is invalid"), 400);
      const extraKind = extraGovernanceKindFor(parsed.data.kind);
      if (extraKind != null) {
        const denied = await requireGovernance(c, { kind: extraKind, artifactId });
        if (denied != null) return denied;
      }
      return () => promotions.act(artifactId, withPrincipal(parsed.data, principal), principal, scope);
    }),
  );
}

/** 501 response when promotions is not injected (shared by 6 routes). */
function promotionsNotConfigured(c: Context): Response {
  return c.json(errorBody("NOT_IMPLEMENTED", "promotions are not configured"), 501);
}

/**
 * Shared get -> 501/404 preamble for routes that load a single candidate by artifactId (GET /promotions/:artifactId
 * and POST /promotions/:artifactId/preview): 501 NOT_IMPLEMENTED if promotions.get is unimplemented; otherwise
 * resolves the owning tenant from the session and looks the candidate up, 404 NOT_FOUND when absent (a tenant
 * mismatch is also treated as nonexistent by get()). Callers must already have confirmed deps.promotions is
 * configured (the pre-existing per-route "promotions are not configured" 501 check).
 * Returns the loaded candidate (never null) on success, or the Response to return as-is otherwise.
 */
async function loadCandidateOrRespond(
  c: Context,
  deps: KohakuHostDeps,
  artifactId: string,
): Promise<Response | unknown> {
  if (deps.promotions?.get == null) {
    return c.json(errorBody("NOT_IMPLEMENTED", "promotions.get is not implemented"), 501);
  }
  const candidate = await deps.promotions.get(artifactId, tenantScopeOf(await resolveTenant(c, deps)));
  if (candidate == null) return c.json(errorBody("NOT_FOUND", "unknown artifact"), 404);
  return candidate;
}

/**
 * Pre-reads the artifact's existence via get and returns 404 if absent (a pre-check to distinguish it from a
 * transition-rejection 422).
 * For a PromotionsApi without get, existence cannot be judged, so pass through and defer to the transition-layer error.
 * Passing scope also performs an owning-tenant check (another tenant's artifact makes get return null -> 404).
 * Returns null when found (= it is fine to proceed).
 */
async function ensureArtifact(
  c: Context,
  promotions: PromotionsApi,
  artifactId: string,
  scope?: { tenant?: string },
): Promise<Response | null> {
  if (promotions.get != null && (await promotions.get(artifactId, scope)) == null) {
    return c.json(errorBody("NOT_FOUND", `unknown artifact ${artifactId}`), 404);
  }
  return null;
}

/**
 * Maps promotion-action exceptions to the error convention. Since depending on lineage is forbidden (reverse
 * dependency), the error kind is discriminated structurally (code / name) without importing the error type. The
 * discriminator literals are shared with the thrower via spec-core's GOVERNANCE_ERROR_DISCRIMINATORS.
 * - PromotionNotPublishedError (code) -> 409 (approved but not published)
 * - TransitionError (name) -> 422 PROMOTION_INVALID (transition rejected)
 * - candidate-store's require() (code) -> 404 (a safeguard for when get is unimplemented and the pre-check could not run)
 * - otherwise -> 500 INTERNAL (message replaced with a fixed string; the original error still reaches onError)
 */
async function promotionError(
  c: Context,
  deps: KohakuHostDeps,
  endpoint: string,
  e: unknown,
): Promise<Response> {
  if ((e as { code?: unknown }).code === GOVERNANCE_ERROR_DISCRIMINATORS.notPublishedCode) {
    // The promotion state the batch transition stopped at (PromotionNotPublishedError.status), carried on
    // the wire as error.status (distinct from the HTTP status of this response; SPEC §6.1).
    const status = (e as { status?: unknown }).status;
    const envelope: ErrorEnvelope = {
      error: {
        code: "PROMOTION_NOT_PUBLISHED",
        message: message(e),
        ...(typeof status === "string" ? { status } : {}),
      },
    };
    return c.json(envelope, 409);
  }
  if ((e as { name?: unknown }).name === GOVERNANCE_ERROR_DISCRIMINATORS.transitionName) {
    return c.json(errorBody("PROMOTION_INVALID", message(e)), 422);
  }
  // The reject bundle transition did not reach rejected (PromotionNotRejectedError). Rather than importing from
  // lineage, discriminate by name via duck-typing (the same approach as PromotionNotPublishedError). To avoid
  // growing the set of error codes in SPEC §6.1, add no dedicated code and map it to PROMOTION_INVALID (422) as a
  // "transition did not take effect" (the reached state is included in the exception message).
  if ((e as { name?: unknown }).name === GOVERNANCE_ERROR_DISCRIMINATORS.notRejectedName) {
    return c.json(errorBody("PROMOTION_INVALID", message(e)), 422);
  }
  // candidate-store's require() throws this when get is unimplemented and the pre-check (ensureArtifact)
  // could not run. Discriminated by code (not a message-text match, which a wording change could break).
  if ((e as { code?: unknown }).code === GOVERNANCE_ERROR_DISCRIMINATORS.artifactNotFoundCode) {
    return c.json(errorBody("NOT_FOUND", message(e)), 404);
  }
  // An unexpected failure. The raw message never reaches the client (it may leak internals); the original
  // error still reaches onError via reportHostError.
  const requestId = requestIdOf(c, deps);
  await reportHostError(deps, endpoint, requestId, e);
  return c.json(errorBody("INTERNAL", PROMOTION_INTERNAL_ERROR_MESSAGE, requestId), 500);
}
