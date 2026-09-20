import { randomUUID } from "node:crypto";
import type { TraceContext } from "@kohaku-ui/composer";
import { errorMessage, notifyHook, parseTraceContext } from "@kohaku-ui/host-core";
import type { Principal, SessionContext, Surface } from "@kohaku-ui/spec-core";
import type { Context } from "hono";
import type { z } from "zod";
import { errorBody } from "../errors.js";
import type { GovernanceOperation } from "../governance-policy.js";
import type { KohakuHostDeps } from "../types.js";

/**
 * The shared context passed to each route group (compose / binding / governance / promotions / fixations).
 * createKohakuRoutes assembles it exactly once. It bundles the state scoped to the app instance (the promotion lock)
 * and the deps-derived hooks (principal extraction, governance authorization) here, aligning each group's signature.
 */
export interface RouteContext {
  deps: KohakuHostDeps;
  /** Principal extraction (deps.auth; the demo ANONYMOUS if not wired). */
  getPrincipal(c: Context): Promise<Principal>;
  /**
   * Governance/audit-plane authorization. Returns a 403 response on rejection, or null on allow (including not wired).
   * See the createKohakuRoutes side for the implementation and fail-open caveats.
   */
  requireGovernance(c: Context, operation: GovernanceOperation): Promise<Response | null>;
  /**
   * Per-tenant serialization of the promotion family's read-modify-write. See the createKohakuRoutes side for the granularity rationale.
   */
  withPromotionLock<T>(tenant: string | undefined, fn: () => Promise<T>): Promise<T>;
}

export const ANONYMOUS: Principal = { id: "demo-user", roles: ["user"] };

export function toSession(
  session: { surface: string; sessionId?: string; locale?: string } | undefined,
  principal: Principal,
  tenant?: string,
): SessionContext {
  return {
    surface: (session?.surface ?? "web") as Surface,
    ...(session?.sessionId != null ? { sessionId: session.sessionId } : {}),
    ...(session?.locale != null ? { locale: session.locale } : {}),
    principal,
    ...(tenant != null ? { tenant } : {}),
  };
}

/**
 * The session metadata (sessionId / tenant) spread into recorder payloads.
 * The single place for the conditional spreads (prevents a copy site from missing one of the two keys).
 */
export function sessionMeta(session: SessionContext): { sessionId?: string; tenant?: string } {
  return {
    ...(session.sessionId != null ? { sessionId: session.sessionId } : {}),
    ...(session.tenant != null ? { tenant: session.tenant } : {}),
  };
}

/** Resolves the tenant from the request. No tenant (undefined) if not wired. */
export async function resolveTenant(c: Context, deps: KohakuHostDeps): Promise<string | undefined> {
  return (await deps.tenant?.(c)) ?? undefined;
}

/**
 * Builds the governance-plane scope object from a resolved tenant.
 * Returns undefined if there is no tenant (aggregation is over all = legacy behavior); otherwise `{ tenant }`.
 * Pure (no I/O) so callers assembling scope for in-process options (withdraw/invalidate) can reuse it too.
 */
export function tenantScopeOf(tenant: string | undefined): { tenant?: string } | undefined {
  return tenant != null ? { tenant } : undefined;
}

/**
 * Resolves the tenant scope of the governance plane (promotions / fixations aggregation).
 * Returns undefined if there is no tenant (aggregation is over all = legacy behavior).
 */
export async function tenantScope(
  c: Context,
  deps: KohakuHostDeps,
): Promise<{ tenant?: string } | undefined> {
  return tenantScopeOf(await resolveTenant(c, deps));
}

/** Thin alias of host-core's errorMessage, kept so its many importers here are untouched by this refactor. */
export function message(e: unknown): string {
  return errorMessage(e);
}

/**
 * JSON parse + schema validation of the request body. On failure, returns BAD_REQUEST 400.
 * Secondary validation (required-field checks, applying defaults for nullish, etc.) is left to the caller.
 * Passing `nullishFallback` safeParses with that value when the JSON is nullish (`?? {}` etc. is specified from the caller side).
 */
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
  badRequestMessage: string,
  options?: { nullishFallback?: unknown },
): Promise<z.infer<S> | Response> {
  let raw: unknown = await c.req.json().catch(() => null);
  if (options != null && "nullishFallback" in options) {
    raw = raw ?? options.nullishFallback;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return c.json(errorBody("BAD_REQUEST", badRequestMessage), 400);
  }
  return parsed.data;
}

/** Upper bound (characters) on an inbound `x-request-id` header accepted as-is (ops). Longer is discarded. */
const MAX_INBOUND_REQUEST_ID_LEN = 128;

/** Printable-ASCII-only check for an inbound `x-request-id` (no control characters, no non-ASCII). */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;

/**
 * Validates and normalizes an inbound `x-request-id` header value (ops). Returns null (= mint a fresh id
 * instead) when the header is absent, empty after trimming, over length, or contains anything outside
 * printable ASCII (a client should not be able to inject control characters / newlines into logs via this
 * header).
 */
function sanitizeInboundRequestId(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INBOUND_REQUEST_ID_LEN) return null;
  if (!PRINTABLE_ASCII_RE.test(trimmed)) return null;
  return trimmed;
}

/** The Hono context-variable key requestIdOf memoizes the per-request correlation id under (see below). */
const REQUEST_ID_VAR = "kohakuRequestId";

/**
 * Resolves (and memoizes) the per-request correlation id (ops). Default behavior: the inbound
 * `x-request-id` request header when present and well-formed, otherwise a fresh `randomUUID()`. A product can
 * override entirely via `deps.requestId`. Always returns a value (unlike the old onError-gated newRequestId):
 * the id is used for the `X-Request-Id` response header on every response, not only on failures.
 *
 * Memoized on the Hono Context's own variable bag (`c.set`/`c.get`), not the raw Request object: a
 * bodyLimit-style middleware ahead of this one may replace `c.req.raw` with a new Request (Hono's own
 * `hono/body-limit` does exactly this once it has buffered a body with no Content-Length header), which would
 * silently break a WeakMap keyed by the raw Request — every call site within the same request (route
 * handler, self-heal reporting, the response-header middleware) would then derive a *different* id instead of
 * sharing one. The Context instance itself, unlike `c.req.raw`, is stable for the whole request lifecycle.
 */
export function requestIdOf(c: Context, deps: KohakuHostDeps): string {
  const cached = c.get(REQUEST_ID_VAR) as string | undefined;
  if (cached != null) return cached;
  const id =
    deps.requestId != null
      ? deps.requestId(c)
      : (sanitizeInboundRequestId(c.req.header("x-request-id")) ?? randomUUID());
  c.set(REQUEST_ID_VAR, id);
  return id;
}

/**
 * Resolves the request's W3C trace context from the standard `traceparent` / `tracestate` request headers
 * (https://www.w3.org/TR/trace-context/), via host-core's shared parseTraceContext (also used by
 * host-mcp-apps' `_meta.traceparent` counterpart) -- so an OTel observer (see @kohaku-ui/otel) can record
 * the compose span as a child of the caller's own trace. Fail-open / additive: undefined when the header is
 * absent or not strictly W3C-formatted, which every call site treats as "propagate nothing" (unchanged
 * behavior from before this option existed). Not memoized (unlike requestIdOf): header parsing is cheap and
 * this is read at most once per request today.
 */
export function traceContextOf(c: Context): TraceContext | undefined {
  return parseTraceContext(c.req.header("traceparent"), c.req.header("tracestate"));
}

/**
 * Calls the failure-path observability hook. Silent if onError is not wired (host-core's notifyHook
 * no-ops on an unwired hook). requestId is always the request's resolved correlation id (from requestIdOf) —
 * every request has one now, regardless of whether onError is wired.
 * Throws / rejections from the hook are swallowed and not propagated to the error response (observation only;
 * host-core's notifyHook is the shared swallow-on-throw building block, consumed by both host profiles).
 */
export async function reportHostError(
  deps: KohakuHostDeps,
  endpoint: string,
  requestId: string,
  error: unknown,
): Promise<void> {
  await notifyHook(deps.onError, { endpoint, requestId, error });
}

/**
 * Groups the per-request correlation data a route handler threads through the compose/capability/audit
 * pipeline: the resolved requestId (requestIdOf), the endpoint name (for observability + error envelopes),
 * the client-disconnect/timeout abort signal (`c.req.raw.signal`), and the optional W3C trace context
 * (traceContextOf). Introduced to collapse the `(deps, endpoint, requestId)` triples and the separate
 * `abort`/`requestId`/`traceContext` parameter lists previously threaded individually through
 * composeForRest / resolveFixatedForRest / issueSpecCapability / finishStream (routes/compose.ts) into one
 * object built once per request.
 */
export interface RestCallContext {
  requestId: string;
  endpoint: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

/**
 * Builds a `report(e)` bound to a fixed (endpoint, requestId) pair — the per-handler shorthand for
 * `reportHostError(deps, call.endpoint, call.requestId, e)` where a handler calls it two or more times
 * (leaving a single use as a direct reportHostError call; see the call sites in compose.ts / fixations.ts).
 * Only wraps reportHostError: this package's former safeRecord helper (also once part of this shape) was
 * removed when its call sites moved into host-core's recordComposedResult, so it has no counterpart here.
 */
export function errorReporterFor(
  deps: KohakuHostDeps,
  call: Pick<RestCallContext, "endpoint" | "requestId">,
): { report(e: unknown): Promise<void> } {
  return {
    report: (e: unknown) => reportHostError(deps, call.endpoint, call.requestId, e),
  };
}
