import {
  type ActionGateResult,
  applyActionEffects,
  CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE,
  failOpen,
  type ParsedInvokableRef,
  parseInvokableRef,
  verifyCapabilitySafely,
} from "@kohaku-ui/host-core";
import {
  actionPayloadHash,
  type JsonObject,
  type Principal,
  type VerifyRequest,
  type VerifyResult,
} from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import type { KohakuHostDeps } from "../types.js";
import { ActionBodySchema } from "./schemas.js";
import {
  ANONYMOUS,
  actionGateFor,
  message,
  operationIndex,
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

/**
 * An action name absent from the DomainPort's own operation index is not a declared operation at all --
 * it must never reach `domain.invoke` (fail-closed), on the same footing as a capability that lacks the
 * needed write scope (this reuses that exact response shape: 403 CAPABILITY_DENIED, no new error code).
 */
const UNDECLARED_ACTION_MESSAGE = "action is not a declared DomainPort operation";

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
      return c.json(
        errorBody(
          "SOURCE_MISMATCH",
          `unknown query source "${parsed.source}" (this host serves "${deps.querySource}")`,
        ),
        404,
      );
    }
    const { base, params } = parsed.ref;

    const verdict = await verifyCapability(deps, c, "binding/resolve", token, {
      kind: "read",
      ref: base.raw,
    });
    if (verdict instanceof Response) return verdict;
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
    const verdict = await verifyCapability(deps, c, "binding/action", token, {
      kind: "write",
      ref: body.action,
    });
    if (verdict instanceof Response) return verdict;
    if (!verdict.ok) {
      return c.json(errorBody("CAPABILITY_DENIED", verdict.reason ?? "capability denied"), 403);
    }
    const principal = resolvePrincipal(deps, c, verdict);
    if (principal instanceof Response) return principal;
    // body.payload is already a validated JsonObject | undefined (ActionBodySchema); no cast needed.
    const payload = body.payload ?? {};
    const requestId = requestIdOf(c, deps);
    const tenant = await resolveTenant(c, deps);

    // Governed actions (design.md #62/#63): validate params and enforce the action's tier before
    // domain.invoke ever runs. An action absent from the DomainPort's own operation index -- whether
    // because the index and DomainPort momentarily disagree, or because the name was never a real
    // operation to begin with -- is rejected here rather than let through ungated (fail-closed; ACT-PRM-001).
    const index = await operationIndex(deps);
    const entry = index.get(body.action);
    if (entry == null) {
      await failOpen(
        async () => {
          await deps.actionAuditRecorder?.denied({
            action: body.action,
            payloadHash: await actionPayloadHash(payload),
            tier: "auto",
            reason: UNDECLARED_ACTION_MESSAGE,
            principal,
            ...(tenant != null ? { tenant } : {}),
            correlationId: requestId,
          });
        },
        (e) => reportHostError(deps, "binding/action.audit", requestId, e),
      );
      return c.json(errorBody("CAPABILITY_DENIED", UNDECLARED_ACTION_MESSAGE), 403);
    }
    const gate = actionGateFor(deps);
    const gateResult = await gate.check({
      descriptor: entry.descriptor,
      paramsSchema: entry.paramsSchema,
      payload,
      confirmed: body.confirmed,
      approval: body.approval,
      requesterId: principal.id,
      tenant,
    });
    const gated = await handleActionGateResult(deps, c, gateResult, {
      action: body.action,
      payload,
      principal,
      tenant,
      requestId,
    });
    if (gated != null) return gated;

    let result: unknown;
    try {
      result = await deps.domain.invoke(body.action, payload, { principal, capability: token });
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

/**
 * Maps one `ActionGate.check` outcome onto the REST response + audit trail (design.md #62/#63; shared
 * shape so `handleActionGateResult`'s caller does not itself branch on `gateResult.kind`). Returns the
 * `Response` to send back to the client (`invalid` / `approvalRequested` / `denied`), or `null` when the
 * gate allowed the invoke (`allow`) and the caller should proceed to `domain.invoke`. Audit recording is
 * always fail-open (host-core's `failOpen`): a recording failure must never turn an otherwise-successful
 * allow, or an otherwise-correct denial, into a 500.
 */
async function handleActionGateResult(
  deps: KohakuHostDeps,
  c: Context,
  gateResult: ActionGateResult,
  ctx: {
    action: string;
    payload: JsonObject;
    principal: Principal;
    tenant: string | undefined;
    requestId: string;
  },
): Promise<Response | null> {
  const { action, principal, tenant, requestId } = ctx;
  const auditReport = (e: unknown): Promise<void> =>
    reportHostError(deps, "binding/action.audit", requestId, e);

  if (gateResult.kind === "invalid") {
    return c.json(
      errorBody(
        "ACTION_PARAMS_INVALID",
        "action parameters failed validation",
        requestId,
        undefined,
        gateResult.issues,
      ),
      422,
    );
  }

  if (gateResult.kind === "approvalRequired") {
    await failOpen(async () => {
      await deps.actionAuditRecorder?.approvalRequested({
        action,
        payloadHash: gateResult.payloadHash,
        tier: gateResult.tier,
        requestId: gateResult.requestId,
        payload: ctx.payload,
        principal,
        ...(tenant != null ? { tenant } : {}),
        correlationId: requestId,
      });
    }, auditReport);
    return c.json(
      errorBody(
        "APPROVAL_REQUIRED",
        gateResult.tier === "confirm"
          ? "this action requires confirmation (confirmed: true)"
          : "this action requires an approval token",
        requestId,
        undefined,
        undefined,
        {
          requestId: gateResult.requestId,
          action,
          tier: gateResult.tier,
          payloadHash: gateResult.payloadHash,
        },
      ),
      403,
    );
  }

  if (gateResult.kind === "denied") {
    await failOpen(async () => {
      await deps.actionAuditRecorder?.denied({
        action,
        payloadHash: gateResult.payloadHash,
        tier: gateResult.tier,
        reason: gateResult.reason,
        principal,
        ...(tenant != null ? { tenant } : {}),
        correlationId: requestId,
      });
    }, auditReport);
    return c.json(
      errorBody("APPROVAL_REQUIRED", gateResult.reason, requestId, undefined, undefined, {
        requestId: gateResult.requestId,
        action,
        tier: gateResult.tier,
        payloadHash: gateResult.payloadHash,
      }),
      403,
    );
  }

  // gateResult.kind === "allow"
  await failOpen(async () => {
    await deps.actionAuditRecorder?.invoked({
      action,
      payloadHash: gateResult.payloadHash,
      tier: gateResult.tier,
      principal,
      ...(tenant != null ? { tenant } : {}),
      correlationId: requestId,
    });
    if (gateResult.grant != null) {
      await deps.actionAuditRecorder?.approved({
        action,
        payloadHash: gateResult.payloadHash,
        grant: gateResult.grant,
        principal,
        ...(tenant != null ? { tenant } : {}),
        correlationId: requestId,
      });
    }
  }, auditReport);
  return null;
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header == null || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}
