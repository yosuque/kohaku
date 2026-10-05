import { type ComposeResult, withTenantCatalog } from "@kohaku-ui/composer";
import * as hostCore from "@kohaku-ui/host-core";
import type { CanonicalIntent, Principal, SessionContext, UISpec } from "@kohaku-ui/spec-core";
import type { Context } from "hono";
import { errorBody } from "../errors.js";
import { withFixationLock } from "../keyed-mutex.js";
import type { KohakuHostDeps } from "../types.js";
import { operationIndex, type RestCallContext, reportHostError } from "./shared.js";

// The compose pipeline shared by the route registrars (compose.ts, fixations.ts): the client-visible failure
// messages, the Intent-resolution failure response, the fixation shortcut -> normal compose sequence, and the
// REST side of capability issuance (the TTL, the write-scope filter and the fail-closed issuance wrapper).
// Kept out of the registrar modules so a route group never imports another route group's module.

/**
 * The client-visible message for an untyped composition failure (COMPOSE_FAILED). An arbitrary exception
 * (a downstream library failure, an unexpected bug) may carry internals unsafe to echo back, so only a
 * "typed" host error (SpecError / ComposeError — see host-core's isTypedHostError) has its own message pass
 * through; anything else collapses to this fixed text. The original error still reaches the observability
 * hook (onError) via reportHostError, so nothing is lost for diagnosis.
 */
export const COMPOSE_FAILED_MESSAGE = "composition failed; see the observability hook (onError) for details";

/**
 * The client-visible message for an untyped Intent-resolution failure (INTENT_INVALID). Same rationale as
 * COMPOSE_FAILED_MESSAGE above: a raw exception's message may leak internals, so it collapses to this fixed
 * text unless it is a "typed" host error (see host-core's isTypedHostError), whose own message is safe to
 * pass through. The original error still reaches the observability hook (onError) via reportHostError.
 */
export const INTENT_INVALID_MESSAGE =
  "intent normalization failed; see the observability hook (onError) for details";

/**
 * The response for a failed Intent resolution (the caller has already reported `e` through reportHostError).
 * Intent resolution cannot degrade without an LLM, so an LLM-provider failure (host-core's
 * classifyHostError → "upstreamUnavailable": LlmError PROVIDER / CONFIG / ABORTED) is the operator's problem,
 * not the client's: 503 INTERNAL with the fixed LLM_PROVIDER_UNAVAILABLE_MESSAGE (the same shape as the
 * capability-verification-unavailable 503). Everything else keeps 422 INTENT_INVALID, with a typed error's
 * own message passed through and anything untyped collapsed to INTENT_INVALID_MESSAGE.
 */
export function intentResolutionFailure(c: Context, e: unknown, requestId: string): Response {
  const cls = hostCore.classifyHostError(e);
  if (cls.kind === "upstreamUnavailable") {
    return c.json(errorBody("INTERNAL", cls.message, requestId), 503);
  }
  return c.json(
    errorBody("INTENT_INVALID", cls.kind === "typed" ? cls.message : INTENT_INVALID_MESSAGE, requestId),
    422,
  );
}

/**
 * Adapts a REST KohakuHostDeps into the FixationDeliveryHost surface host-core's fixation helpers consume.
 * serialize wires the per-(tenant, intentHash) fixation lock (withFixationLock) so self-heal's
 * read-modify-write cannot interleave with the management plane's fixate/unfixate. onSelfHealError
 * fires the failure-path observability hook fire-and-forget (a throw/rejection from the hook is swallowed
 * inside reportHostError, never surfaced to the caller).
 *
 * Cached per deps (analogous to keyed-mutex.ts's fixationMutexByDeps): deps is fixed for the lifetime of a
 * createKohakuRoutes app instance, and this object holds no per-request state, so building it once per deps
 * and reusing it avoids reallocating on every /compose, /compose/stream, /events, and /fixations/approve call
 * (the last of which calls composeForRest directly with `deps`, outside any single RouteContext-scoped
 * closure, hence caching by deps rather than by a route-local ctx).
 */
const fixationHostByDeps = new WeakMap<KohakuHostDeps, hostCore.FixationDeliveryHost>();
function fixationHost(deps: KohakuHostDeps): hostCore.FixationDeliveryHost {
  let host = fixationHostByDeps.get(deps);
  if (host == null) {
    host = {
      // fixationLookup (deprecated) takes priority when wired (backward compatible); otherwise fall back to
      // the plain read on FixationsApi.get, with delivery gating handled separately by `admit` below.
      lookup:
        deps.fixationLookup ??
        (deps.fixations?.get != null
          ? (intentHash, session) =>
              deps.fixations!.get!(
                intentHash,
                session.tenant != null ? { tenant: session.tenant } : undefined,
              )
          : undefined),
      admit: deps.fixationAdmit,
      fixations: deps.fixations,
      serialize: (scope, fn) => withFixationLock(deps, scope.tenant, scope.intentHash, fn),
      // requestId is threaded in by resolveFixatedForRest/composeForRest below from the triggering request;
      // the crypto.randomUUID() fallback only guards a hypothetical future caller that omits it.
      // globalThis.crypto (not node:crypto) so this file has no Node-only import: Node >= 19 and every
      // evergreen browser both expose the same Web Crypto randomUUID() on globalThis.crypto.
      onSelfHealError: (endpoint, error, requestId) => {
        void reportHostError(deps, endpoint, requestId ?? globalThis.crypto.randomUUID(), error);
      },
    };
    fixationHostByDeps.set(deps, host);
  }
  return host;
}

/**
 * Resolves the L0 fixation shortcut (L0 fixation = pinning an L1-generated spec down to a fixed L0 spec, L1->L0).
 * This is the single source of truth shared by composeForRest (used by /compose and /events) and the
 * fixation shortcut in /compose/stream. Delegates the materialize/settle sequence to host-core, sharing it with
 * host-mcp-apps. Revalidation uses the tenant's catalog (when promotion splits catalogs per tenant,
 * validating against the global catalog would cause a fingerprint mismatch and an unnecessary stale verdict; a
 * no-op when catalogFor is not wired). No fixation / stale (staleness detection; self-healing is fired by
 * host-core's settleFixation) returns null, and the caller falls back to normal compose / streaming generation.
 */
export async function resolveFixatedForRest(
  intent: CanonicalIntent,
  session: SessionContext,
  deps: KohakuHostDeps,
  call: RestCallContext,
): Promise<ComposeResult | null> {
  return hostCore.resolveFixatedResult(
    intent,
    session,
    withTenantCatalog(deps.compose, session.tenant),
    fixationHost(deps),
    call.requestId,
  );
}

/**
 * Fixation shortcut -> normal compose (shared by /compose, /events, and /fixations/approve). call.requestId is
 * threaded into host-core's fixation self-healing (FixationDeliveryHost.onSelfHealError) so a self-heal
 * failure can be tied back to the request that triggered it. call.traceContext, when present (the
 * `traceparent` request header via shared.ts's traceContextOf), is threaded into the normal-compose fallback
 * as ComposeOptions.traceContext -- additive/opt-in, same as requestId/correlationId (see host-core's
 * composeWithFixation doc comment). call.signal is the client-disconnect / timeout abort signal.
 * call.endpoint is accepted for a uniform call-site shape shared with resolveFixatedForRest /
 * issueSpecCapability / finishStream, though composeForRest itself has no direct use for it (its callers
 * report their own failures via reportHostError).
 */
export async function composeForRest(
  intent: CanonicalIntent,
  session: SessionContext,
  deps: KohakuHostDeps,
  call: RestCallContext,
): Promise<ComposeResult> {
  // materialize validates against the tenant catalog; the normal-compose fallback runs against the untenanted
  // deps.compose (compose() re-applies tenant/session internally).
  return hostCore.composeWithFixation(
    intent,
    session,
    {
      materialize: withTenantCatalog(deps.compose, session.tenant),
      compose: deps.compose,
      ...(call.signal != null ? { abort: call.signal } : {}),
    },
    fixationHost(deps),
    call.requestId,
    call.traceContext,
  );
}

/** The effective capability TTL: deps.capabilityTtlSeconds when set, otherwise host-core's shared default. */
export function capabilityTtl(deps: KohakuHostDeps): number {
  return deps.capabilityTtlSeconds ?? hostCore.DEFAULT_CAPABILITY_TTL_SECONDS;
}

/**
 * Issues a capability matching the Spec's declarations (components' read references + the /binding/action
 * write-through path). Delegates to host-core's issueSpecCapabilitySafely, the fail-closed wrapper shared with
 * the MCP profile (host-mcp-apps' composeAndPackage), which in turn consumes issueCapabilityForSpec / spec-core's
 * collectCapabilityScopes (the single source of truth) so both profiles agree on the issuance rule.
 *
 * Write scopes are additionally restricted to the DomainPort's listOperations() names (hardening against a
 * hallucinated/injected action.invoke action name becoming a bearer write scope): the allowed set is memoized
 * per deps below (listOperations is async and must not be awaited on every compose). issueSpecCapabilitySafely
 * reports a dropped action via the endpoint's onError hook as a WriteScopeDroppedError, and — if listOperations
 * itself rejects — still issues the capability but fail-closed for writes (an empty allowed set), reporting the
 * rejection the same way; delivery proceeds either way.
 */
export async function issueSpecCapability(
  spec: UISpec,
  principal: Principal,
  deps: KohakuHostDeps,
  call: RestCallContext,
): Promise<string> {
  return hostCore.issueSpecCapabilitySafely(
    deps.authz,
    principal,
    spec,
    () => allowedActions(deps),
    (e) => reportHostError(deps, call.endpoint, call.requestId, e),
    capabilityTtl(deps),
  );
}

/**
 * The write-scope filter for capability issuance, derived from the same per-deps `OperationIndex` the action
 * gate and the `actions` manifest use (routes/shared.ts's `operationIndex`), so the three can never disagree
 * about which actions exist and `listOperations()` is read (and memoized) once.
 */
function allowedActions(deps: KohakuHostDeps): Promise<ReadonlySet<string>> {
  return hostCore.allowedActionsFromIndex(() => operationIndex(deps))();
}
