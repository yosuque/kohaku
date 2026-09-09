import { applyActionEffects, type ParsedInvokableRef, parseInvokableRef } from "@kohaku-ui/host-core";
import type { Principal, VerifyResult } from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import type { KohakuHostDeps } from "../types.js";
import { ActionBodySchema } from "./schemas.js";
import { ANONYMOUS, message, parseBody, type RouteContext, reportHostError, requestIdOf } from "./shared.js";

/**
 * A raw downstream (DomainPort.invoke) failure never reaches the client verbatim on the REF_NOT_FOUND path: it
 * may carry internals (SQL fragments, stack-trace text, library-internal wording). Classifying a permanent
 * "no such reference" versus a transient failure would require a typed Port contract, so both collapse to this
 * fixed message; the original error still reaches the observability hook (onError) via reportHostError.
 */
const REF_NOT_FOUND_MESSAGE = "reference not found or not resolvable";

/**
 * Resolves the principal to act as for a verified capability. When `deps.auth` is wired (the host performs
 * real authentication), a `verify` that returns `ok:true` without a principal is a capability-issuer
 * misconfiguration and must not silently degrade to ANONYMOUS — doing so would let an authenticated
 * deployment act as the demo user. Denied with 403 CAPABILITY_DENIED in that case. When `deps.auth` is unwired
 * (the unauthenticated demo path), ANONYMOUS is the expected, intentional principal.
 * Returns the Response to return as-is on denial, or the resolved Principal on success.
 */
function resolvePrincipal(deps: KohakuHostDeps, c: Context, verdict: VerifyResult): Response | Principal {
  if (verdict.principal != null) return verdict.principal;
  if (deps.auth == null) return ANONYMOUS;
  return c.json(errorBody("CAPABILITY_DENIED", "capability verified without a principal"), 403);
}

/** Reference-passing data resolution / write-through path (/binding/resolve, /binding/action). capability required. */
export function registerBindingRoutes(app: Hono, ctx: RouteContext): void {
  const { deps } = ctx;

  // --- Reference-passing data resolution (component -> API direct. capability required) ---
  app.get("/binding/resolve", async (c) => {
    const refParam = c.req.query("ref");
    if (refParam == null) {
      return c.json(errorBody("BAD_REQUEST", "ref query parameter is required"), 400);
    }
    const token = bearerToken(c);
    if (token == null) {
      return c.json(errorBody("CAPABILITY_REQUIRED", "Authorization: Bearer <capability> is required"), 401);
    }

    // Server-side paging/sorting: parse ref into base (with reserved params removed) and reserved via
    // host-core's parseInvokableRef (shared with the MCP profile's resolve_binding tool / initial-data
    // preresolution). capability verification is an exact match against base.raw (= the canonical form of
    // the $ref the Spec declared). Only known reserved-param keys (_cursor/_limit/_sort/_dir) are allowed —
    // since the reserved namespace is outside authorization checks, passing an unknown `_` key through would
    // let the data range be changed with parameters outside the capability.
    let parsed: ParsedInvokableRef;
    try {
      parsed = parseInvokableRef(refParam, deps.querySource);
    } catch (e) {
      return c.json(errorBody("BAD_REQUEST", message(e)), 400);
    }
    if (parsed.kind === "source_mismatch") {
      return c.json(errorBody("SOURCE_MISMATCH", `unknown query source "${parsed.source}"`), 404);
    }
    const { base, params } = parsed.ref;

    const verdict = await deps.authz.verify(token, { kind: "read", ref: base.raw });
    if (!verdict.ok) {
      return c.json(errorBody("CAPABILITY_DENIED", verdict.reason ?? "capability denied"), 403);
    }
    const principal = resolvePrincipal(deps, c, verdict);
    if (principal instanceof Response) return principal;

    try {
      // Reserved params (_cursor/_limit/_sort/_dir) are already merged into params by parseInvokableRef
      // (the `_` namespace convention — DomainPort signature unchanged).
      const data = await deps.domain.invoke(base.path, params, { principal, capability: token });
      return c.json(data as object);
    } catch (e) {
      // Downstream (DomainPort) failures are also placed on the observability hook (symmetric with the other
      // composition handlers' failure-path observability), rather than turning into a 404 that goes unobserved.
      // The response stays REF_NOT_FOUND (404) — classifying
      // a permanent "no such reference" versus a transient failure entails introducing a Port contract (typed
      // errors), so that is left as a separate decision. The raw error message never reaches the client (it may
      // leak internals); the original error still reaches onError via reportHostError.
      const requestId = requestIdOf(c, deps);
      await reportHostError(deps, "binding/resolve", requestId, e);
      return c.json(errorBody("REF_NOT_FOUND", REF_NOT_FOUND_MESSAGE, requestId), 404);
    }
  });

  // --- Write-through path (presentForm submit, etc.) ---
  app.post("/binding/action", async (c) => {
    const body = await parseBody(c, ActionBodySchema, "action is required");
    if (body instanceof Response) return body;
    const token = bearerToken(c);
    if (token == null) {
      return c.json(errorBody("CAPABILITY_REQUIRED", "Authorization: Bearer <capability> is required"), 401);
    }
    const verdict = await deps.authz.verify(token, { kind: "write", ref: body.action });
    if (!verdict.ok) {
      return c.json(errorBody("CAPABILITY_DENIED", verdict.reason ?? "capability denied"), 403);
    }
    const principal = resolvePrincipal(deps, c, verdict);
    if (principal instanceof Response) return principal;
    // body.payload is already a validated JsonObject | undefined (ActionBodySchema); no cast needed.
    const payload = body.payload ?? {};
    let result: unknown;
    try {
      result = await deps.domain.invoke(body.action, payload, { principal, capability: token });
    } catch (e) {
      // Failure of the write itself (domain.invoke) is 404. Place the downstream failure on the
      // observability hook, then map it. The raw error message never reaches the client (see REF_NOT_FOUND_MESSAGE).
      const requestId = requestIdOf(c, deps);
      await reportHostError(deps, "binding/action", requestId, e);
      return c.json(errorBody("REF_NOT_FOUND", REF_NOT_FOUND_MESSAGE, requestId), 404);
    }
    // Write-already-committed vs. side-effect-declaration failure: see host-core's applyActionEffects.
    const response = await applyActionEffects(deps.actionEffects, body.action, payload, result, async (e) => {
      const requestId = requestIdOf(c, deps);
      await reportHostError(deps, "binding/action.effects", requestId, e);
    });
    return c.json(response);
  });
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header == null || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}
