import { isTypedHostError } from "@kohaku-ui/host-core";
import { finalizeIntent, GOVERNANCE_ERROR_DISCRIMINATORS } from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import { withFixationLock } from "../keyed-mutex.js";
import { COMPOSE_FAILED_MESSAGE, composeForRest } from "./compose.js";
import { ComposeBodySchema } from "./schemas.js";
import {
  message,
  parseBody,
  type RouteContext,
  reportHostError,
  requestIdOf,
  resolveTenant,
  tenantScope,
  tenantScopeOf,
  toSession,
  traceContextOf,
} from "./shared.js";

/**
 * The client-visible message for an unexpected fixation-removal failure (INTERNAL 500). See
 * COMPOSE_FAILED_MESSAGE's doc (compose.ts) for the rationale (an arbitrary exception's message may leak
 * internals; the original error still reaches the observability hook via reportHostError).
 */
const FIXATION_INTERNAL_ERROR_MESSAGE =
  "fixation removal failed; see the observability hook (onError) for details";

/** Management plane of fixation (L1->L0) (the 4 /fixations routes). */
export function registerFixationRoutes(app: Hono, ctx: RouteContext): void {
  const { deps, getPrincipal, requireGovernance } = ctx;

  app.get("/fixations", async (c) => {
    if (deps.fixations == null) return fixationsNotConfigured(c);
    const denied = await requireGovernance(c, { kind: "fixation.list" });
    if (denied != null) return denied;
    return c.json({ fixations: await deps.fixations.list(await tenantScope(c, deps)) });
  });

  app.get("/fixations/proposals", async (c) => {
    if (deps.fixations == null) return fixationsNotConfigured(c);
    const denied = await requireGovernance(c, { kind: "fixation.proposals" });
    if (denied != null) return denied;
    return c.json({ proposals: await deps.fixations.proposals(await tenantScope(c, deps)) });
  });

  app.post("/fixations/approve", async (c) => {
    if (deps.fixations == null) return fixationsNotConfigured(c);
    const fixations = deps.fixations;
    const denied = await requireGovernance(c, { kind: "fixation.approve" });
    if (denied != null) return denied;
    const requestId = requestIdOf(c, deps);
    const principal = await getPrincipal(c);
    const tenant = await resolveTenant(c, deps);
    const body = await parseBody(c, ComposeBodySchema, "intent (canonical + params) is required");
    if (body instanceof Response) return body;
    if (body.intent == null) {
      return c.json(errorBody("BAD_REQUEST", "intent (canonical + params) is required"), 400);
    }
    try {
      // Fetch the current composition result (should be cached) and fix its structure. The fixation is stamped onto this tenant.
      const intent = await finalizeIntent({
        canonical: body.intent.canonical,
        params: body.intent.params,
      });
      const result = await composeForRest(
        intent,
        toSession(undefined, principal, tenant),
        deps,
        c.req.raw.signal,
        requestId,
        traceContextOf(c),
      );
      // A generation failure must not be pinned as L0 for everyone: a deterministic fallback Spec
      // ("Could not render") is not fixatable.
      const fb = result.spec.provenance.fallback;
      if (fb != null) {
        return c.json(
          errorBody(
            "COMPOSE_FAILED",
            `composition fell back (${fb.reason}); a fallback Spec cannot be fixated`,
            requestId,
          ),
          422,
        );
      }
      // L2 free-form results are governed by the promotion pipeline (L2->L1), not fixation.
      if (result.spec.provenance.tier === "L2") {
        return c.json(
          errorBody(
            "BAD_REQUEST",
            "L2 free-form results are governed by the promotion pipeline (L2->L1), not fixation",
            requestId,
          ),
          400,
        );
      }
      // The fixation write is serialized under the same (tenant, intentHash) lock as self-healing
      // (refreshFingerprint / invalidate) (interleaving causes resurrection of a deleted fixation / mistaken deletion of a new one).
      const record = await withFixationLock(deps, tenant, intent.hash, () =>
        fixations.fixate({
          pinnedSpec: result.spec,
          approver: principal,
          ...(tenant != null ? { tenant } : {}),
        }),
      );
      return c.json({ fixation: record });
    } catch (e) {
      await reportHostError(deps, "fixations/approve", requestId, e);
      // An arbitrary exception's message never reaches the client (it may leak internals); a typed host error
      // (SpecError/ComposeError) still passes its own message through. The original error still reaches
      // onError via reportHostError above.
      const clientMessage = isTypedHostError(e) ? message(e) : COMPOSE_FAILED_MESSAGE;
      return c.json(errorBody("COMPOSE_FAILED", clientMessage, requestId), 500);
    }
  });

  app.post("/fixations/:intentHash/remove", async (c) => {
    if (deps.fixations == null) return fixationsNotConfigured(c);
    const fixations = deps.fixations;
    const denied = await requireGovernance(c, {
      kind: "fixation.remove",
      intentHash: c.req.param("intentHash"),
    });
    if (denied != null) return denied;
    const principal = await getPrincipal(c);
    const tenant = await resolveTenant(c, deps);
    try {
      // Serialize under the same (tenant, intentHash) lock as self-healing (refreshFingerprint / invalidate).
      await withFixationLock(deps, tenant, c.req.param("intentHash"), () =>
        fixations.unfixate(c.req.param("intentHash"), principal, tenantScopeOf(tenant)),
      );
    } catch (e) {
      // Since depending on lineage is forbidden (reverse dependency), discriminate the fail-fast error structurally
      // by the code property (spec-core's GOVERNANCE_ERROR_DISCRIMINATORS.fixationUnsupportedCode). deleteFixation
      // unimplemented maps to 501 (its own message is safe: a fixed string the host itself defines), anything else
      // unexpected maps to 500 with a fixed message (the raw message may leak internals; the original error still
      // reaches onError via reportHostError).
      if ((e as { code?: unknown }).code === GOVERNANCE_ERROR_DISCRIMINATORS.fixationUnsupportedCode) {
        return c.json(errorBody("NOT_IMPLEMENTED", message(e)), 501);
      }
      const requestId = requestIdOf(c, deps);
      await reportHostError(deps, "fixations/remove", requestId, e);
      const clientMessage = isTypedHostError(e) ? message(e) : FIXATION_INTERNAL_ERROR_MESSAGE;
      return c.json(errorBody("INTERNAL", clientMessage, requestId), 500);
    }
    return c.json({ ok: true });
  });
}

/** 501 response when fixations is not injected (shared by 4 routes; symmetric with promotionsNotConfigured). */
function fixationsNotConfigured(c: Context): Response {
  return c.json(errorBody("NOT_IMPLEMENTED", "fixations are not configured"), 501);
}
