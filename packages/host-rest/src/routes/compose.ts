import { randomUUID } from "node:crypto";
import { type ComposeResult, composeStream, type TraceContext, withTenantCatalog } from "@kohaku-ui/composer";
import * as hostCore from "@kohaku-ui/host-core";
import {
  type CanonicalIntent,
  computeSpecHash,
  finalizeIntent,
  type Principal,
  type SemanticInput,
  type SessionContext,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { z } from "zod";
import { errorBody } from "../errors.js";
import { withFixationLock } from "../keyed-mutex.js";
import type { KohakuHostDeps } from "../types.js";
import { ComposeBodySchema, EventsBodySchema } from "./schemas.js";
import {
  parseBody,
  type RouteContext,
  reportHostError,
  requestIdOf,
  resolveTenant,
  safeRecord,
  sessionMeta,
  toSession,
  traceContextOf,
} from "./shared.js";

/** SSE heartbeat (comment line) send interval. Kept shorter than the idle timeout (~60s) of LBs / reverse proxies. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

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

/** Composition routes (/intent/normalize, /compose, /compose/stream, /events). */
export function registerComposeRoutes(app: Hono, ctx: RouteContext): void {
  const { deps, getPrincipal } = ctx;

  // --- Intent normalization (for the chat "normalization chip" display) ---
  app.post("/intent/normalize", async (c) => {
    const requestId = requestIdOf(c, deps);
    const body = await parseBody(c, ComposeBodySchema, "input (NLQuery | GuiAction) is required");
    if (body instanceof Response) return body;
    if (body.input == null) {
      return c.json(errorBody("BAD_REQUEST", "input (NLQuery | GuiAction) is required"), 400);
    }
    const session = toSession(body.session, await getPrincipal(c), await resolveTenant(c, deps));
    try {
      const input = body.input as SemanticInput;
      const intent = await resolveSemanticInput(input, session, deps);
      return c.json({
        intent,
        source: input.kind === "nl" ? "llm" : "deterministic",
      });
    } catch (e) {
      await reportHostError(deps, "intent/normalize", requestId, e);
      const clientMessage = hostCore.clientMessageFor(e, INTENT_INVALID_MESSAGE);
      return c.json(errorBody("INTENT_INVALID", clientMessage, requestId), 422);
    }
  });

  // --- Compose (fixation shortcut -> cache -> composer) ---
  app.post("/compose", async (c) => {
    const resolved = await resolveComposeRequest(c, ctx, "compose");
    if (resolved instanceof Response) return resolved;
    const { intent, session, principal, requestId, traceContext } = resolved;

    // The non-streaming path computes specHash exactly once inside the recorder implementation (no duplication).
    return deliverComposed(c, {
      intent,
      session,
      principal,
      deps,
      requestId,
      traceContext,
      endpoint: "compose",
      signal: c.req.raw.signal,
    });
  });

  // --- Compose streaming (SSE: immediate skeleton -> finalized-form patch. SPEC §6.1.1 [Draft]) --
  app.post("/compose/stream", async (c) => {
    // The shared preamble completes Intent normalization before the stream starts, so failures return as a
    // normal 400/422 (the HTTP status cannot be changed once the SSE stream has started).
    const resolved = await resolveComposeRequest(c, ctx, "compose/stream");
    if (resolved instanceof Response) return resolved;
    const { intent, session, principal, requestId, traceContext } = resolved;
    return deliverComposedStream(c, { intent, session, principal, deps, requestId, traceContext });
  });

  // --- Interaction loop (component event -> Intent delta -> recomposition) ---
  app.post("/events", async (c) => {
    const requestId = requestIdOf(c, deps);
    const traceContext = traceContextOf(c);
    const body = await parseBody(c, EventsBodySchema, "intent and event are required");
    if (body instanceof Response) return body;
    // componentId is the first half of on("<componentId>.<event>"). Reject an on without a dot, since the
    // component ID cannot be identified and an incorrect componentId would be recorded to lineage.
    if (!body.event.on.includes(".")) {
      return c.json(errorBody("BAD_REQUEST", 'event.on must be "<componentId>.<event>"'), 400);
    }
    const principal = await getPrincipal(c);
    const session = toSession(body.session, principal, await resolveTenant(c, deps));

    // Intent normalization (finalizeIntent / semantic.normalize) failures are client-caused (unknown action, etc.).
    // Symmetrically with /compose, map them to 422 INTENT_INVALID and separate them from internal-error
    // (recomposition) 500 COMPOSE_FAILED.
    let current: CanonicalIntent;
    let intent: CanonicalIntent;
    try {
      current = await finalizeIntent({
        canonical: body.intent.canonical,
        params: body.intent.params,
      });
      // Intent resolution (host-core's resolveIntent, shared with the MCP profile's compose-tool nl/intent branch).
      ({ intent } = await hostCore.resolveIntent(
        deps.compose.semantic,
        { kind: "gui", current, action: body.event.on, params: body.event.payload },
        session,
      ));
    } catch (e) {
      await reportHostError(deps, "events", requestId, e);
      const clientMessage = hostCore.clientMessageFor(e, INTENT_INVALID_MESSAGE);
      return c.json(errorBody("INTENT_INVALID", clientMessage, requestId), 422);
    }

    return deliverComposed(c, {
      intent,
      session,
      principal,
      deps,
      requestId,
      traceContext,
      endpoint: "events",
      signal: c.req.raw.signal,
      // /events-specific: record interacted before recordComposed (preserve execution order).
      beforeRecord: async () => {
        await deps.recorder?.interacted({
          intentHash: current.hash,
          componentId: body.event.on.split(".")[0]!,
          on: body.event.on,
          payload: body.event.payload,
          surface: session.surface,
          ...sessionMeta(session),
        });
      },
    });
  });
}

/**
 * Shared preamble of /compose and /compose/stream: body parse/validation -> principal/session resolution ->
 * Intent resolution. Returns a Response on request errors (400 for parse/required-field, 422 INTENT_INVALID).
 * Kept strictly to the synchronous pre-stream portion: both endpoints must fail before any SSE starts,
 * because the HTTP status cannot be changed once the stream has begun.
 */
async function resolveComposeRequest(
  c: Context,
  ctx: RouteContext,
  endpoint: "compose" | "compose/stream",
): Promise<
  | Response
  | {
      intent: CanonicalIntent;
      session: SessionContext;
      principal: Principal;
      requestId: string;
      traceContext?: TraceContext;
    }
> {
  const { deps, getPrincipal } = ctx;
  const requestId = requestIdOf(c, deps);
  const traceContext = traceContextOf(c);
  const body = await parseBody(c, ComposeBodySchema, "either input or intent is required");
  if (body instanceof Response) return body;
  if (body.input == null && body.intent == null) {
    return c.json(errorBody("BAD_REQUEST", "either input or intent is required"), 400);
  }
  const principal = await getPrincipal(c);
  const session = toSession(body.session, principal, await resolveTenant(c, deps));
  try {
    const intent = await resolveIntentFromBody(body, session, deps);
    return { intent, session, principal, requestId, traceContext };
  } catch (e) {
    await reportHostError(deps, endpoint, requestId, e);
    const clientMessage = hostCore.clientMessageFor(e, INTENT_INVALID_MESSAGE);
    return c.json(errorBody("INTENT_INVALID", clientMessage, requestId), 422);
  }
}

/**
 * Shared skeleton for the latter half of /compose and /events: composeForRest -> capability issuance ->
 * audit recording (fail-open) -> JSON response.
 * Failures are COMPOSE_FAILED 500. The endpoint name is passed as-is to logs / error reporting.
 * beforeRecord runs inside safeRecord, before recordComposed (for /events' interacted).
 */
async function deliverComposed(
  c: Context,
  args: {
    intent: CanonicalIntent;
    session: SessionContext;
    principal: Principal;
    deps: KohakuHostDeps;
    requestId: string;
    traceContext?: TraceContext;
    endpoint: string;
    signal: AbortSignal;
    beforeRecord?: () => Promise<void>;
  },
): Promise<Response> {
  const { intent, session, principal, deps, requestId, traceContext, endpoint, signal, beforeRecord } = args;
  try {
    // Propagate client-disconnect / timeout aborts through to compose (the L1/L2 LLM calls).
    const result = await composeForRest(intent, session, deps, signal, requestId, traceContext);
    const capability = await issueSpecCapability(result.spec, principal, deps, endpoint, requestId);
    // Audit recording is fail-open, prioritizing delivery availability: swallow recorder failures so they do
    // not take down delivery (including cached Specs), notify the observability hook (onError) of the failure, and
    // still return a successful response.
    // A cancelled compose (the caller's abort fired) is not a generation failure and observer.onError
    // already received phase:"cancelled" from the composer — skip lineage recording entirely so a client
    // disconnect/timeout does not inflate view.composed / view.fallback counts. The fallback body is still
    // returned as usual.
    if (result.trace.cancelled !== true) {
      await safeRecord(deps, endpoint, requestId, async () => {
        await beforeRecord?.();
        // Compute specHash exactly once and share it between recordComposed and recordFallbackIfAny
        // (mirroring finishStream): without it, each independently hashes the same Spec when a fallback
        // occurred (view.composed always runs; view.fallback additionally runs only on a fallback Spec).
        const specHash = await computeSpecHash(result.spec);
        await recordComposed(deps, result, session, specHash);
        await recordFallbackIfAny(deps, result, session, specHash);
      });
    }
    return c.json({ spec: result.spec, capability });
  } catch (e) {
    await reportHostError(deps, endpoint, requestId, e);
    const clientMessage = hostCore.clientMessageFor(e, COMPOSE_FAILED_MESSAGE);
    return c.json(errorBody("COMPOSE_FAILED", clientMessage, requestId), 500);
  }
}

/**
 * The streaming counterpart of deliverComposed for /compose/stream: fixation shortcut -> SSE
 * skeleton/patch/done -> audit recording, over an SSE response (hono's streamSSE). Kept as its own
 * function, separate from registerComposeRoutes' route wiring, so that the route registration body
 * stays a short list of route -> delivery-function wirings, matching deliverComposed's split for the
 * non-streaming path.
 */
async function deliverComposedStream(
  c: Context,
  args: {
    intent: CanonicalIntent;
    session: SessionContext;
    principal: Principal;
    deps: KohakuHostDeps;
    requestId: string;
    traceContext?: TraceContext;
  },
): Promise<Response> {
  const { intent, session, principal, deps, requestId, traceContext } = args;
  // Propagate client-disconnect / timeout aborts through to composeStream (the L1/L2 LLM calls).
  const abort = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    // During generation (after the skeleton is sent, until L1 generation/repair completes) there can be a long
    // gap with no output, which reverse proxies / LBs may cut off at their idle timeout. Periodically emit SSE
    // comment lines to keep the connection alive (the client parser ignores comment lines — the ":" branch in
    // client/stream.ts / renderer-react/use-spec-stream.ts).
    const heartbeat = setInterval(() => {
      stream.write(": keepalive\n\n").catch(() => {
        // Ignore write failures after disconnect (the main-body write / termination handling deals with failures).
      });
    }, SSE_HEARTBEAT_INTERVAL_MS);
    try {
      // Fixation shortcut (resolveFixatedForRest = the single source of truth shared with composeForRest):
      // on hit, a single final:true event + done. The capability is issued from the $ref inside the fixed Spec
      // (no skeleton is involved, so refs-based issuance is unnecessary). No fixation / stale (staleness
      // detection) returns null = fall through to the streaming generation path below.
      const fixated = await resolveFixatedForRest(intent, session, deps, requestId);
      if (fixated != null) {
        const capability = await issueSpecCapability(
          fixated.spec,
          principal,
          deps,
          "compose/stream",
          requestId,
        );
        await stream.writeSSE({
          event: "spec",
          data: JSON.stringify({ spec: fixated.spec, capability, final: true }),
        });
        await finishStream(deps, stream, fixated, session, requestId);
        return;
      }

      // L1/L2 path: skeleton (final:false) -> patch -> done. The capability is issued exactly once on the
      // first event.
      //
      // final:true (cache hit / L0 fixed Spec — composeStream can complete in a single event without ever
      // emitting a skeleton) is issued from the Spec itself, via the same issueSpecCapability wrapper as
      // the fixation shortcut above: collectCapabilityScopes covers both the $ref/bind-variant read scopes
      // and any action.invoke write scope the final Spec declares, and enforces MAX_BIND_VARIANTS (an
      // overflow throws into the catch below -> event: error COMPOSE_FAILED). A final Spec can declare
      // action.invoke (e.g. presentForm submit) — without this, that write scope would never be
      // issued and /binding/action would always 403 for a stream-delivered final Spec.
      //
      // final:false (the skeleton) has no $ref yet, so it is issued read-only from composeStream's resolved
      // refs instead (host-core's issueCapabilityForRefs). bind (two-way binding, [Draft]) is declared only
      // on the final Spec and is not opened up to L1/L2 generation (generation:excluded), so a skeleton never
      // needs bind variants; consequently an L1/L2-generated Spec delivered via patches after this skeleton
      // carries no write scope either (documented limitation — only a single-event final:true response can
      // carry action.invoke over the stream).
      let capability: string | undefined;
      let final: ComposeResult | undefined;
      for await (const ev of composeStream({ kind: "intent", intent }, deps.compose, {
        session,
        abort,
        correlationId: requestId,
        ...(traceContext != null ? { traceContext } : {}),
      })) {
        if (ev.kind === "spec") {
          capability ??= ev.final
            ? await issueSpecCapability(ev.spec, principal, deps, "compose/stream", requestId)
            : await hostCore.issueCapabilityForRefs(deps.authz, principal, ev.refs, capabilityTtl(deps));
          await stream.writeSSE({
            event: "spec",
            data: JSON.stringify({ spec: ev.spec, capability, final: ev.final }),
          });
        } else if (ev.kind === "patch") {
          await stream.writeSSE({ event: "patch", data: JSON.stringify({ patch: ev.patch }) });
        } else {
          final = ev.result;
        }
      }
      // recorder / view.fallback runs exactly once against the final Spec (the skeleton is not recorded).
      if (final != null) await finishStream(deps, stream, final, session, requestId);
    } catch (e) {
      // A client disconnect / request timeout surfaces here too (composeStream's for-await loop / a
      // stream.writeSSE call above rejects once the underlying connection is gone). That is not a
      // generation failure: reporting it to onError would inflate failure metrics with routine
      // disconnects, and writing an error event onto an already-closed stream would just reject again
      // (a second, unhandled rejection previously fell through to hono's own console.error with a raw
      // stack). Skip both and let `finally` alone clean up.
      if (!abort.aborted) {
        // The HTTP status cannot be changed once the stream has started, so terminate with an error event.
        await reportHostError(deps, "compose/stream", requestId, e);
        const clientMessage = hostCore.clientMessageFor(e, COMPOSE_FAILED_MESSAGE);
        await stream
          .writeSSE({
            event: "error",
            data: JSON.stringify(errorBody("COMPOSE_FAILED", clientMessage, requestId)),
          })
          .catch((writeError) => {
            // The client may have disconnected in the gap between the abort check above and this write;
            // swallow the resulting rejection rather than letting it become a second, unhandled error.
            if (!abort.aborted) throw writeError;
          });
      }
    } finally {
      clearInterval(heartbeat);
    }
  });
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
      // the randomUUID() fallback only guards a hypothetical future caller that omits it.
      onSelfHealError: (endpoint, error, requestId) => {
        void reportHostError(deps, endpoint, requestId ?? randomUUID(), error);
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
async function resolveFixatedForRest(
  intent: CanonicalIntent,
  session: SessionContext,
  deps: KohakuHostDeps,
  requestId?: string,
): Promise<ComposeResult | null> {
  return hostCore.resolveFixatedResult(
    intent,
    session,
    withTenantCatalog(deps.compose, session.tenant),
    fixationHost(deps),
    requestId,
  );
}

/**
 * Fixation shortcut -> normal compose (shared by /compose, /events, and /fixations/approve). requestId, when
 * passed, is threaded into host-core's fixation self-healing (FixationDeliveryHost.onSelfHealError) so a
 * self-heal failure can be tied back to the request that triggered it. traceContext, when passed (the
 * `traceparent` request header via shared.ts's traceContextOf), is threaded into the normal-compose fallback
 * as ComposeOptions.traceContext -- additive/opt-in, same as requestId/correlationId (see host-core's
 * composeWithFixation doc comment).
 */
export async function composeForRest(
  intent: CanonicalIntent,
  session: SessionContext,
  deps: KohakuHostDeps,
  abort?: AbortSignal,
  requestId?: string,
  traceContext?: TraceContext,
): Promise<ComposeResult> {
  // materialize validates against the tenant catalog; the normal-compose fallback runs against the untenanted
  // deps.compose (compose() re-applies tenant/session internally).
  return hostCore.composeWithFixation(
    intent,
    session,
    {
      materialize: withTenantCatalog(deps.compose, session.tenant),
      compose: deps.compose,
      ...(abort != null ? { abort } : {}),
    },
    fixationHost(deps),
    requestId,
    traceContext,
  );
}

/**
 * Centralizes the recorder.composed call in one place (shared by /compose, /events, and finishStream; prevents
 * missing spreads of session metadata (sessionId / tenant); isomorphic to the Python implementation's
 * _record_composed). specHash is passed only when the streaming path shares its precomputed value; the
 * non-streaming path computes it exactly once inside the recorder implementation.
 */
async function recordComposed(
  deps: KohakuHostDeps,
  result: ComposeResult,
  session: SessionContext,
  specHash?: string,
): Promise<void> {
  await deps.recorder?.composed({
    spec: result.spec,
    trace: result.trace,
    surface: session.surface,
    ...(specHash != null ? { specHash } : {}),
    ...sessionMeta(session),
  });
}

/**
 * Records view.fallback when the spec includes a fallback (deterministic downgrade on generation failure /
 * capability-negotiation downgrade). Delegates the fallback-detection rule (spec.provenance.fallback, not the
 * trace) to host-core's recordViewFallback, shared with the MCP profile's composeAndAudit, so both profiles
 * agree on when a fallback is recorded.
 */
async function recordFallbackIfAny(
  deps: KohakuHostDeps,
  result: ComposeResult,
  session: SessionContext,
  specHash?: string,
): Promise<void> {
  await hostCore.recordViewFallback(deps.recorder, result.spec, {
    surface: session.surface,
    ...(specHash != null ? { specHash } : {}),
    ...sessionMeta(session),
  });
}

/** The effective capability TTL: deps.capabilityTtlSeconds when set, otherwise host-core's shared default. */
function capabilityTtl(deps: KohakuHostDeps): number {
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
async function issueSpecCapability(
  spec: UISpec,
  principal: Principal,
  deps: KohakuHostDeps,
  endpoint: string,
  requestId: string,
): Promise<string> {
  return hostCore.issueSpecCapabilitySafely(
    deps.authz,
    principal,
    spec,
    () => allowedActions(deps),
    (e) => reportHostError(deps, endpoint, requestId, e),
    capabilityTtl(deps),
  );
}

/**
 * Per-deps memoized `AllowedActions` (host-core's createAllowedActions, shared with the MCP profile so both
 * profiles agree on how a DomainPort's listOperations() names are cached and retried). Built once per deps
 * (listOperations is async and must not be re-awaited on every compose).
 */
const allowedActionsByDeps = new WeakMap<KohakuHostDeps, hostCore.AllowedActions>();
function allowedActions(deps: KohakuHostDeps): Promise<ReadonlySet<string>> {
  let fn = allowedActionsByDeps.get(deps);
  if (fn == null) {
    fn = hostCore.createAllowedActions(deps.domain);
    allowedActionsByDeps.set(deps, fn);
  }
  return fn();
}

/**
 * SSE stream termination handling. Records lineage exactly once against the final Spec (the skeleton is not
 * recorded), writes the done event ({specHash, tier, cache}), and terminates.
 */
async function finishStream(
  deps: KohakuHostDeps,
  stream: SSEStreamingApi,
  result: ComposeResult,
  session: SessionContext,
  requestId: string,
): Promise<void> {
  // Compute specHash exactly once per request and share it between the recorder (view.composed) and the done
  // event, avoiding hashing the same Spec twice.
  const specHash = await computeSpecHash(result.spec);
  // Audit recording is fail-open, prioritizing delivery availability: swallow recorder failures so they do
  // not take down emitting the done event (= normal termination), and notify the observability hook (onError) of the failure.
  // Same cancelled-skip as deliverComposed: a client disconnect/timeout must not inflate view.composed /
  // view.fallback counts, and observer.onError already received phase:"cancelled" from the composer.
  if (result.trace.cancelled !== true) {
    await safeRecord(deps, "compose/stream", requestId, async () => {
      await recordComposed(deps, result, session, specHash);
      await recordFallbackIfAny(deps, result, session, specHash);
    });
  }
  await stream.writeSSE({
    event: "done",
    data: JSON.stringify({
      specHash,
      tier: result.spec.provenance.tier,
      cache: result.spec.provenance.cache,
    }),
  });
}

/**
 * Resolves a CanonicalIntent from the ComposeBody (shared by /compose and /compose/stream).
 * If body.intent is present, resolved directly (host-core's "intent" source); otherwise delegated to
 * resolveSemanticInput. Failures (INTENT_INVALID) are mapped to 422 by the caller, so throws are passed
 * through here.
 */
async function resolveIntentFromBody(
  body: z.infer<typeof ComposeBodySchema>,
  session: SessionContext,
  deps: KohakuHostDeps,
): Promise<CanonicalIntent> {
  if (body.intent != null) {
    const { intent } = await hostCore.resolveIntent(
      deps.compose.semantic,
      {
        kind: "intent",
        intent: { canonical: body.intent.canonical, params: body.intent.params },
      },
      session,
    );
    return intent;
  }
  return resolveSemanticInput(body.input as SemanticInput, session, deps);
}

/**
 * Resolves a CanonicalIntent from a raw SemanticInput (NLQuery | GuiAction) via host-core's shared
 * resolveIntent helper — shared by /intent/normalize and resolveIntentFromBody so both go through the same
 * normalization/finalization sequence as the MCP profile's compose-tool nl branch and REST/MCP's own "gui"
 * event paths. host-core's "gui" IntentSource variant takes `current` as optional (mirroring GuiAction), so
 * a currentless GuiAction (a fresh gui action against no prior Intent) also resolves through resolveIntent —
 * no direct semantic.normalize bypass is needed here.
 */
async function resolveSemanticInput(
  input: SemanticInput,
  session: SessionContext,
  deps: KohakuHostDeps,
): Promise<CanonicalIntent> {
  if (input.kind === "nl") {
    const { intent } = await hostCore.resolveIntent(
      deps.compose.semantic,
      { kind: "nl", text: input.text, ...(input.locale != null ? { locale: input.locale } : {}) },
      session,
    );
    return intent;
  }
  const { intent } = await hostCore.resolveIntent(
    deps.compose.semantic,
    {
      kind: "gui",
      action: input.action,
      params: input.params,
      ...(input.current != null ? { current: input.current } : {}),
    },
    session,
  );
  return intent;
}
