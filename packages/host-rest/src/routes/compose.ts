import { type ComposeResult, composeStream, type TraceContext } from "@kohaku-ui/composer";
import * as hostCore from "@kohaku-ui/host-core";
import {
  type CanonicalIntent,
  computeSpecHash,
  type Principal,
  type SemanticInput,
  type SessionContext,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { z } from "zod";
import { errorBody } from "../errors.js";
import type { KohakuHostDeps } from "../types.js";
import {
  COMPOSE_FAILED_MESSAGE,
  composeForRest,
  intentResolutionFailure,
  resolveFixatedForRest,
} from "./compose-pipeline.js";
import { ComposeBodySchema, EventsBodySchema } from "./schemas.js";
import {
  operationIndex,
  parseBody,
  type RestCallContext,
  type RouteContext,
  reportHostError,
  requestIdOf,
  resolveTenant,
  sessionMeta,
  toSession,
  traceContextOf,
} from "./shared.js";

/** SSE heartbeat (comment line) send interval. Kept shorter than the idle timeout (~60s) of LBs / reverse proxies. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

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
      // The same resolveIntent sequence as resolveIntentFromBody's raw-input branch (see its doc comment).
      const { intent } = await hostCore.resolveIntent(deps.compose.semantic, input, session);
      return c.json({
        intent,
        source: input.kind === "nl" ? "llm" : "deterministic",
      });
    } catch (e) {
      await reportHostError(deps, "intent/normalize", requestId, e);
      return intentResolutionFailure(c, e, requestId);
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
      call: { requestId, endpoint: "compose", signal: c.req.raw.signal, traceContext },
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

    // Intent resolution (resolveIntent's "intent" / "gui" sources, covering validateIntent + semantic.normalize)
    // failures are client-caused (unknown intent/action, invalid params, etc.). Symmetrically with /compose,
    // map them to 422 INTENT_INVALID and separate them from internal-error (recomposition) 500 COMPOSE_FAILED.
    let current: CanonicalIntent;
    let intent: CanonicalIntent;
    try {
      // Resolved through host-core's resolveIntent (the "intent" source), not a bare finalizeIntent, so a
      // SemanticPort.validateIntent implementation gets a chance to reject an unknown canonical or invalid
      // params in `current` too — the same closed gap as body.intent on /compose.
      ({ intent: current } = await hostCore.resolveIntent(
        deps.compose.semantic,
        { kind: "intent", intent: body.intent },
        session,
      ));
      // Intent resolution (host-core's resolveIntent, shared with the MCP profile's compose-tool nl/intent branch).
      ({ intent } = await hostCore.resolveIntent(
        deps.compose.semantic,
        { kind: "gui", current, action: body.event.on, params: body.event.payload },
        session,
      ));
    } catch (e) {
      await reportHostError(deps, "events", requestId, e);
      return intentResolutionFailure(c, e, requestId);
    }

    return deliverComposed(c, {
      intent,
      session,
      principal,
      deps,
      call: { requestId, endpoint: "events", signal: c.req.raw.signal, traceContext },
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
 * The Action manifest for `spec` (design.md #62/#64, SPEC §6.1/§6.1.1), computed from the host's
 * `OperationIndex` (memoized via `operationIndex`, shared with `/binding/action`'s `ActionGate` -- both
 * consult the exact same index). Placed alongside `capability` in the compose response, outside the Spec
 * itself, so it never affects `specHash` / the cache key. `undefined` (never `{}`) when the Spec declares
 * no write actions, so every existing response shape (a read-only Spec) is byte-identical to before this
 * field existed once JSON-serialized (the key is simply absent).
 *
 * A declared operation whose `paramsSchema` failed validation is omitted from the manifest on its own (see
 * `buildActionManifest`). Fail-open on a rejected `operationIndex` (`listOperations()` itself throwing): reported to the observability hook and treated as "no manifest this
 * time" rather than failing the whole compose response, the same fail-open posture
 * `issueSpecCapabilitySafely` already takes for capability issuance under the identical failure. That
 * fail-open build is host-core's `buildActionManifestSafely`, shared with the MCP profile's compose tool; this
 * wrapper only supplies the REST profile's own index and endpoint name for the report.
 */
function actionsFor(
  deps: KohakuHostDeps,
  spec: UISpec,
  call: Pick<RestCallContext, "endpoint" | "requestId">,
): Promise<hostCore.ActionManifest | undefined> {
  return hostCore.buildActionManifestSafely(
    () => operationIndex(deps),
    spec,
    (e) => reportHostError(deps, call.endpoint, call.requestId, e),
  );
}

/**
 * Shared preamble of /compose and /compose/stream: body parse/validation -> principal/session resolution ->
 * Intent resolution. Returns a Response on request errors (400 for parse/required-field, 422 INTENT_INVALID,
 * 503 INTERNAL when the LLM provider is unavailable — see intentResolutionFailure).
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
    return intentResolutionFailure(c, e, requestId);
  }
}

/**
 * Shared skeleton for the latter half of /compose and /events: composeForRest -> capability issuance ->
 * audit recording (fail-open) -> JSON response.
 * Failures are COMPOSE_FAILED 500. The endpoint name (call.endpoint) is passed as-is to logs / error reporting.
 * beforeRecord runs inside recordComposedResult's record callback, before recordComposed (for /events' interacted).
 */
async function deliverComposed(
  c: Context,
  args: {
    intent: CanonicalIntent;
    session: SessionContext;
    principal: Principal;
    deps: KohakuHostDeps;
    call: RestCallContext;
    beforeRecord?: () => Promise<void>;
  },
): Promise<Response> {
  const { intent, session, principal, deps, call, beforeRecord } = args;
  // Used twice below (the audit-recording failure callback and the outer catch), hence a local binding
  // rather than two direct reportHostError(deps, call.endpoint, call.requestId, e) calls.
  const report = (e: unknown) => reportHostError(deps, call.endpoint, call.requestId, e);
  try {
    // Propagate client-disconnect / timeout aborts through to compose (the L1/L2 LLM calls; call.signal).
    const result = await composeForRest(intent, session, deps, call);
    const capability = await issueSpecCapability(result.spec, principal, deps, call);
    // Audit recording is cancelled-aware and fail-open (host-core's recordComposedResult, shared with the MCP
    // profile's composeAndAudit): swallow recorder failures so they do not take down delivery (including
    // cached Specs), notify the observability hook (onError) of the failure, and still return a successful
    // response. A cancelled compose (the caller's abort fired) is not a generation failure and observer.onError
    // already received phase:"cancelled" from the composer — recordComposedResult skips lineage recording
    // entirely so a client disconnect/timeout does not inflate view.composed / view.fallback counts. The
    // fallback body is still returned as usual.
    await hostCore.recordComposedResult(
      result,
      async () => {
        await beforeRecord?.();
        // Compute specHash exactly once and share it between recordComposed and recordFallbackIfAny
        // (mirroring finishStream): without it, each independently hashes the same Spec when a fallback
        // occurred (view.composed always runs; view.fallback additionally runs only on a fallback Spec).
        const specHash = await computeSpecHash(result.spec);
        await recordComposed(deps, result, session, specHash);
        await recordFallbackIfAny(deps, result, session, specHash);
      },
      report,
    );
    const actions = await actionsFor(deps, result.spec, call);
    return c.json({ spec: result.spec, capability, ...(actions != null ? { actions } : {}) });
  } catch (e) {
    await report(e);
    const clientMessage = hostCore.clientMessageFor(e, COMPOSE_FAILED_MESSAGE);
    return c.json(errorBody("COMPOSE_FAILED", clientMessage, call.requestId), 500);
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
  // Built once and threaded through resolveFixatedForRest / issueSpecCapability / finishStream below (all
  // /compose/stream calls, hence the fixed "compose/stream" endpoint).
  const call: RestCallContext = { requestId, endpoint: "compose/stream", signal: abort, traceContext };

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
      const fixated = await resolveFixatedForRest(intent, session, deps, call);
      if (fixated != null) {
        await streamFixated(stream, fixated, { session, principal, deps, call });
        return;
      }
      await streamGenerated(stream, { intent, session, principal, deps, call, abort });
    } catch (e) {
      // A client disconnect / request timeout surfaces here too (composeStream's for-await loop / a
      // stream.writeSSE call above rejects once the underlying connection is gone). That is not a
      // generation failure: reporting it to onError would inflate failure metrics with routine
      // disconnects, and writing an error event onto an already-closed stream would just reject again
      // (a second, unhandled rejection previously fell through to hono's own console.error with a raw
      // stack). Skip both and let `finally` alone clean up.
      if (!abort.aborted) {
        // The HTTP status cannot be changed once the stream has started, so terminate with an error event.
        await reportHostError(deps, call.endpoint, call.requestId, e);
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
 * The fixation-shortcut leg of deliverComposedStream: a single final:true spec event followed by done. The
 * capability is issued from the $ref inside the fixed Spec (no skeleton is involved, so refs-based issuance
 * is unnecessary). Any failure propagates to deliverComposedStream's abort-aware catch.
 */
async function streamFixated(
  stream: SSEStreamingApi,
  fixated: ComposeResult,
  args: { session: SessionContext; principal: Principal; deps: KohakuHostDeps; call: RestCallContext },
): Promise<void> {
  const { session, principal, deps, call } = args;
  const capability = await issueSpecCapability(fixated.spec, principal, deps, call);
  const actions = await actionsFor(deps, fixated.spec, call);
  await stream.writeSSE({
    event: "spec",
    data: JSON.stringify({
      spec: fixated.spec,
      capability,
      final: true,
      ...(actions != null ? { actions } : {}),
    }),
  });
  await finishStream(deps, stream, fixated, session, call);
}

/**
 * The streaming-generation leg of deliverComposedStream (no fixation hit): skeleton (final:false) -> patch ->
 * done. Any failure (including an abort surfacing from composeStream or a write) propagates to
 * deliverComposedStream's abort-aware catch. `abort` is the same client-disconnect / timeout signal as
 * `call.signal`, passed explicitly because the latter is optional on RestCallContext.
 */
async function streamGenerated(
  stream: SSEStreamingApi,
  args: {
    intent: CanonicalIntent;
    session: SessionContext;
    principal: Principal;
    deps: KohakuHostDeps;
    call: RestCallContext;
    abort: AbortSignal;
  },
): Promise<void> {
  const { intent, session, principal, deps, call, abort } = args;
  // L1/L2 path: skeleton (final:false) -> patch -> done. The capability is issued exactly once on the
  // first event.
  //
  // final:true (cache hit / L0 fixed Spec — composeStream can complete in a single event without ever
  // emitting a skeleton) is issued from the Spec itself, via the same issueSpecCapability wrapper as
  // streamFixated: collectCapabilityScopes covers both the $ref/bind-variant read scopes
  // and any action.invoke write scope the final Spec declares, and enforces MAX_BIND_VARIANTS (an
  // overflow throws into deliverComposedStream's catch -> event: error COMPOSE_FAILED). A final Spec can declare
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
    correlationId: call.requestId,
    ...(call.traceContext != null ? { traceContext: call.traceContext } : {}),
  })) {
    if (ev.kind === "spec") {
      capability ??= ev.final
        ? await issueSpecCapability(ev.spec, principal, deps, call)
        : await hostCore.issueCapabilityForRefs(deps.authz, principal, ev.refs, capabilityTtl(deps));
      const actions = await actionsFor(deps, ev.spec, call);
      await stream.writeSSE({
        event: "spec",
        data: JSON.stringify({
          spec: ev.spec,
          capability,
          final: ev.final,
          ...(actions != null ? { actions } : {}),
        }),
      });
    } else if (ev.kind === "patch") {
      await stream.writeSSE({ event: "patch", data: JSON.stringify({ patch: ev.patch }) });
    } else {
      final = ev.result;
    }
  }
  // recorder / view.fallback runs exactly once against the final Spec (the skeleton is not recorded).
  if (final != null) await finishStream(deps, stream, final, session, call);
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
    ...(result.trace.correlationId != null ? { correlationId: result.trace.correlationId } : {}),
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

/**
 * SSE stream termination handling. Records lineage exactly once against the final Spec (the skeleton is not
 * recorded), writes the done event ({specHash, tier, cache}), and terminates.
 */
async function finishStream(
  deps: KohakuHostDeps,
  stream: SSEStreamingApi,
  result: ComposeResult,
  session: SessionContext,
  call: RestCallContext,
): Promise<void> {
  // Compute specHash exactly once per request and share it between the recorder (view.composed) and the done
  // event, avoiding hashing the same Spec twice.
  const specHash = await computeSpecHash(result.spec);
  // Audit recording is cancelled-aware and fail-open (host-core's recordComposedResult): swallow recorder
  // failures so they do not take down emitting the done event (= normal termination), and notify the
  // observability hook (onError) of the failure. Same cancelled-skip as deliverComposed: a client
  // disconnect/timeout must not inflate view.composed / view.fallback counts, and observer.onError already
  // received phase:"cancelled" from the composer.
  await hostCore.recordComposedResult(
    result,
    async () => {
      await recordComposed(deps, result, session, specHash);
      await recordFallbackIfAny(deps, result, session, specHash);
    },
    (e) => reportHostError(deps, call.endpoint, call.requestId, e),
  );
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
 * If body.intent is present, resolved directly (host-core's "intent" source); otherwise the raw SemanticInput
 * (NLQuery | GuiAction) goes through the same resolveIntent helper — the sequence shared with
 * /intent/normalize, the MCP profile's compose-tool nl branch and REST/MCP's own "gui" event paths.
 * host-core's "gui" IntentSource variant takes `current` as optional (mirroring GuiAction), so a currentless
 * GuiAction (a fresh gui action against no prior Intent) also resolves through resolveIntent — no direct
 * semantic.normalize bypass is needed here. Failures (INTENT_INVALID) are mapped to 422 by the caller, so
 * throws are passed through here.
 */
async function resolveIntentFromBody(
  body: z.infer<typeof ComposeBodySchema>,
  session: SessionContext,
  deps: KohakuHostDeps,
): Promise<CanonicalIntent> {
  const source: hostCore.IntentSource =
    body.intent != null ? { kind: "intent", intent: body.intent } : (body.input as SemanticInput);
  const { intent } = await hostCore.resolveIntent(deps.compose.semantic, source, session);
  return intent;
}
