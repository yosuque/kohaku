import {
  ACTION_GATE_UNAVAILABLE_MESSAGE,
  applyActionEffects,
  CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE,
  errorMessage,
  GATED_READ_MESSAGE,
  type ParsedInvokableRef,
  parseInvokableRef,
  runActionGate,
  runGatedReadGuard,
  UNDECLARED_ACTION_MESSAGE,
  verifyCapabilitySafely,
} from "@kohaku-ui/host-core";
import {
  type ActionParamIssue,
  findUnsafeActionParamKeys,
  type JsonObject,
  type Principal,
  type VerifyRequest,
  type VerifyResult,
} from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import type { KohakuHostDeps } from "../types.js";
import { takeRateLimit } from "./rate-limit.js";
import { ActionBodySchema } from "./schemas.js";
import {
  ANONYMOUS,
  parseBody,
  type RouteContext,
  reportHostError,
  requestIdOf,
  resolveTenant,
} from "./shared.js";

/**
 * A raw downstream (DomainPort.invoke) failure never reaches the client verbatim on the REF_NOT_FOUND path: it
 * may carry internals (SQL fragments, stack-trace text, library-internal wording). Classifying a permanent
 * "no such reference" versus a transient failure would require a typed Port contract, so both collapse to this
 * fixed message; the original error still reaches the observability hook (onError) via reportHostError.
 */
const REF_NOT_FOUND_MESSAGE = "reference not found or not resolvable";

/** Client message when a declared operation's `paramsSchema` failed validation: that operation is never invoked. */
const ACTION_DECLARATION_INVALID_MESSAGE = "action is not available on this host";

/**
 * The unsafe-key issues (SPEC ACT-PRM-001) of the request body's raw `payload`. The gate scans the *parsed*
 * payload, but `JsonObjectSchema` (zod's record) silently strips an own `__proto__` key while parsing, so the
 * gate alone would never see it; `JSON.parse` keeps it as an own property, so the raw body is scanned here
 * and the result is fed to the same 422 path the gate takes. Empty when the body has no object `payload`.
 * Bounded: `parseBody` already rejected a body nested beyond the maximum request depth.
 */
async function rawPayloadUnsafeKeyIssues(c: Context): Promise<ActionParamIssue[]> {
  const raw: unknown = await c.req.json().catch(() => null);
  const payload = (raw as { payload?: unknown } | null)?.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  return findUnsafeActionParamKeys(payload as JsonObject);
}

/**
 * Calls `authz.verify` via host-core's `verifyCapabilitySafely` (shared with the MCP profile), and maps its
 * `"unavailable"` outcome to a 503 `INTERNAL` response rather than letting a thrown `verify` propagate as an
 * unhandled rejection / raw 500. The original error still reaches the observability hook via reportHostError,
 * symmetric with every other failure-path response in this file.
 */
async function verifyCapability(
  deps: KohakuHostDeps,
  c: Context,
  endpoint: string,
  token: string,
  req: VerifyRequest,
): Promise<VerifyResult | Response> {
  const requestId = requestIdOf(c, deps);
  const result = await verifyCapabilitySafely(deps.authz, token, req, (e) =>
    reportHostError(deps, endpoint, requestId, e),
  );
  if (result.kind === "unavailable") {
    return c.json(errorBody("INTERNAL", CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE, requestId), 503);
  }
  return result.verdict;
}

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

/** Client message when the tenant bound into a capability and the request's resolved tenant disagree. */
const CAPABILITY_TENANT_MISMATCH_MESSAGE = "capability tenant does not match the request tenant";

/**
 * The tenant a verified capability runs under (SPEC CAP-TEN-002). The tenant signed into the capability is
 * authoritative: when the host also resolves a tenant for this request (`deps.tenant`) and it differs, the
 * request is denied (fail-closed) rather than silently preferring either side. A capability that binds no
 * tenant (issued by a host that never resolved one, or before tenants were signed) falls back to the host's
 * own resolution, which keeps pre-upgrade tokens working. Returns the Response to return as-is on a mismatch.
 */
async function effectiveTenant(
  deps: KohakuHostDeps,
  c: Context,
  verdict: VerifyResult,
): Promise<Response | string | undefined> {
  const resolved = await resolveTenant(c, deps);
  const bound = verdict.tenant;
  if (bound == null || bound === "") return resolved;
  if (resolved != null && resolved !== bound) {
    return c.json(errorBody("CAPABILITY_DENIED", CAPABILITY_TENANT_MISMATCH_MESSAGE), 403);
  }
  return bound;
}

/** What `authorizeAndRateLimit` hands a capability-gated handler: who acts, and under which tenant. */
interface AuthorizedCapability {
  principal: Principal;
  tenant: string | undefined;
}

/**
 * The shared authorization prologue of the capability-gated routes: verify the bearer token against
 * `request` (a thrown `verify` is the 503 of `verifyCapability`), deny a `!ok` verdict with 403
 * CAPABILITY_DENIED (carrying the verdict's own reason), resolve the principal to act as
 * (`resolvePrincipal`), settle the tenant (`effectiveTenant`), and finally take the route's rate-limit token
 * keyed by that verified (tenant, principal, routeClass) -- after verification, so the key is never taken
 * from unauthenticated request headers. Returns the Response to return as-is on any denial, or the resolved
 * principal and tenant.
 */
async function authorizeAndRateLimit(
  ctx: RouteContext,
  c: Context,
  endpoint: string,
  token: string,
  request: VerifyRequest,
  routeClass: "action" | "resolve",
): Promise<Response | AuthorizedCapability> {
  const { deps } = ctx;
  const verdict = await verifyCapability(deps, c, endpoint, token, request);
  if (verdict instanceof Response) return verdict;
  if (!verdict.ok) {
    return c.json(errorBody("CAPABILITY_DENIED", verdict.reason ?? "capability denied"), 403);
  }
  const principal = resolvePrincipal(deps, c, verdict);
  if (principal instanceof Response) return principal;
  const tenant = await effectiveTenant(deps, c, verdict);
  if (tenant instanceof Response) return tenant;
  const limited = await takeRateLimit(ctx, c, { tenant, principal: principal.id, routeClass });
  if (limited != null) return limited;
  return { principal, tenant };
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
      return c.json(errorBody("BAD_REQUEST", errorMessage(e)), 400);
    }
    if (parsed.kind === "source_mismatch") {
      return c.json(
        errorBody(
          "SOURCE_MISMATCH",
          `unknown query source "${parsed.source}" (this host serves "${deps.querySource}")`,
        ),
        404,
      );
    }
    const { base, params } = parsed.ref;

    const authorized = await authorizeAndRateLimit(
      ctx,
      c,
      "binding/resolve",
      token,
      { kind: "read", ref: base.raw },
      "resolve",
    );
    if (authorized instanceof Response) return authorized;
    const { principal, tenant } = authorized;

    // The read path never runs a governed Action (SPEC ACT-RD-001, design.md #77): a ref naming an operation
    // whose tier is "confirm" / "approve" is refused before domain.invoke, since only /binding/action holds
    // such an operation for a confirmation or an approval. An unreadable operation index fails closed (503),
    // the same outcome the action path gives. host-core's runGatedReadGuard audits both as `action.denied`.
    const requestId = requestIdOf(c, deps);
    const guard = await runGatedReadGuard({
      operationIndex: () => ctx.operationIndex(),
      operation: base.path,
      audit: {
        recorder: deps.actionAuditRecorder,
        action: base.path,
        payload: params,
        principal,
        tenant,
        correlationId: requestId,
        report: (e: unknown) => reportHostError(deps, "binding/resolve.audit", requestId, e),
      },
      report: {
        indexFailure: (e) => reportHostError(deps, "binding/resolve", requestId, e),
        schemaError: (e) => reportHostError(deps, "binding/resolve", requestId, e),
      },
    });
    switch (guard.kind) {
      case "indexUnavailable":
        return c.json(errorBody("INTERNAL", ACTION_GATE_UNAVAILABLE_MESSAGE, requestId), 503);
      case "gated":
        return c.json(errorBody("CAPABILITY_DENIED", GATED_READ_MESSAGE, requestId), 403);
      // A declared operation whose paramsSchema failed validation is never invoked on the read path either:
      // fail closed (500), the action path's outcome for it.
      case "schemaInvalid":
        return c.json(errorBody("INTERNAL", ACTION_DECLARATION_INVALID_MESSAGE, requestId), 500);
      case "readable":
        break;
    }

    try {
      // Reserved params (_cursor/_limit/_sort/_dir) are already merged into params by parseInvokableRef
      // (the `_` namespace convention — DomainPort signature unchanged).
      const data = await deps.domain.invoke(base.path, params, {
        principal,
        capability: token,
        ...(tenant != null ? { tenant } : {}),
      });
      return c.json(data as object);
    } catch (e) {
      // Downstream (DomainPort) failures are also placed on the observability hook (symmetric with the other
      // composition handlers' failure-path observability), rather than turning into a 404 that goes unobserved.
      // The response stays REF_NOT_FOUND (404) — classifying
      // a permanent "no such reference" versus a transient failure entails introducing a Port contract (typed
      // errors), so that is left as a separate decision. The raw error message never reaches the client (it may
      // leak internals); the original error still reaches onError via reportHostError.
      await reportHostError(deps, "binding/resolve", requestId, e);
      return c.json(errorBody("REF_NOT_FOUND", REF_NOT_FOUND_MESSAGE, requestId), 404);
    }
  });

  // --- Write-through path (presentForm submit, etc.) ---
  app.post("/binding/action", async (c) => {
    // The bearer's presence is checked before the body is read and parsed: with the rate limiter now behind
    // capability verification, a flood of unauthenticated requests should be turned away as cheaply as possible.
    const token = bearerToken(c);
    if (token == null) {
      return c.json(errorBody("CAPABILITY_REQUIRED", "Authorization: Bearer <capability> is required"), 401);
    }
    const body = await parseBody(c, ActionBodySchema, "action is required");
    if (body instanceof Response) return body;
    const authorized = await authorizeAndRateLimit(
      ctx,
      c,
      "binding/action",
      token,
      { kind: "write", ref: body.action },
      "action",
    );
    if (authorized instanceof Response) return authorized;
    // The tenant is the capability's signed one (SPEC CAP-TEN-002), not the request header's: it scopes the
    // approval token binding below, the audit record and the domain invocation alike.
    const { principal, tenant } = authorized;
    // body.payload is already a validated JsonObject | undefined (ActionBodySchema); no cast needed.
    const payload = body.payload ?? {};
    const requestId = requestIdOf(c, deps);

    // Governed actions (design.md #62/#63): validate params and enforce the action's tier before
    // domain.invoke ever runs. An action absent from the DomainPort's own operation index -- whether
    // because the index and DomainPort momentarily disagree, or because the name was never a real
    // operation to begin with -- is rejected here rather than let through ungated (fail-closed; ACT-PRM-001).
    // A gate that cannot decide at all (index unreadable, ApprovalPort outage) is a denial too (ACT-APR-001).
    const auditContext = {
      recorder: deps.actionAuditRecorder,
      action: body.action,
      payload,
      principal,
      tenant,
      correlationId: requestId,
      report: (e: unknown) => reportHostError(deps, "binding/action.audit", requestId, e),
    };
    const reportGate = (e: unknown) => reportHostError(deps, "binding/action", requestId, e);
    // The sequence itself (operation index -> undeclared / schema checks -> raw unsafe-key scan -> gate ->
    // audit) is host-core's `runActionGate`, shared with the MCP profile; this keeps only the wire mapping
    // (design.md #62/#63): `indexUnavailable` / `gateUnavailable` -> 503, `undeclared` -> 403,
    // `schemaInvalid` -> 500, `invalid` -> 422, `approvalRequired` -> 403, and `proceed` falls through to
    // `domain.invoke`. The audit trail and the client-visible messages are host-core's too.
    const outcome = await runActionGate({
      operationIndex: () => ctx.operationIndex(),
      gate: ctx.actionGate,
      audit: auditContext,
      confirmed: body.confirmed,
      approval: body.approval,
      unsafeKeyIssues: () => rawPayloadUnsafeKeyIssues(c),
      report: { indexFailure: reportGate, schemaError: reportGate, gateFailure: reportGate },
    });
    switch (outcome.kind) {
      case "indexUnavailable":
      case "gateUnavailable":
        return c.json(errorBody("INTERNAL", ACTION_GATE_UNAVAILABLE_MESSAGE, requestId), 503);
      case "undeclared":
        return c.json(errorBody("CAPABILITY_DENIED", UNDECLARED_ACTION_MESSAGE), 403);
      // A declared operation whose paramsSchema failed validation must never be invoked: fail closed (500),
      // the same outcome a schema error had before the index confined it to one operation.
      case "schemaInvalid":
        return c.json(errorBody("INTERNAL", ACTION_DECLARATION_INVALID_MESSAGE, requestId), 500);
      case "invalid":
        return c.json(
          errorBody(
            "ACTION_PARAMS_INVALID",
            "action parameters failed validation",
            requestId,
            undefined,
            outcome.issues,
          ),
          422,
        );
      case "approvalRequired":
        return c.json(
          errorBody("APPROVAL_REQUIRED", outcome.message, requestId, undefined, undefined, outcome.approval),
          403,
        );
      case "proceed":
        break;
    }

    let result: unknown;
    try {
      result = await deps.domain.invoke(body.action, payload, {
        principal,
        capability: token,
        ...(tenant != null ? { tenant } : {}),
      });
    } catch (e) {
      // Failure of the write itself (domain.invoke) is 404. Place the downstream failure on the
      // observability hook, then map it. The raw error message never reaches the client (see REF_NOT_FOUND_MESSAGE).
      await reportHostError(deps, "binding/action", requestId, e);
      return c.json(errorBody("REF_NOT_FOUND", REF_NOT_FOUND_MESSAGE, requestId), 404);
    }
    // Write-already-committed vs. side-effect-declaration failure: see host-core's applyActionEffects.
    const response = await applyActionEffects(deps.actionEffects, body.action, payload, result, async (e) => {
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
