import { errorMessage } from "@kohaku-ui/host-core";
import type { LineageFilter, LineagePageRequest, Surface } from "@kohaku-ui/spec-core";
import { APPROVAL_ISSUE_ERROR_CODE, LineageCursorError, parseIso8601 } from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import { ApprovalRequestBodySchema, TelemetryBodySchema } from "./schemas.js";
import { parseBody, type RouteContext, reportHostError, requestIdOf, resolveTenant } from "./shared.js";

/** Aggregation window for usage analytics. Default 200 / max 1000 (aligned with the /lineage window limits). */
const ANALYTICS_DEFAULT_LIMIT = 200;
const ANALYTICS_MAX_LIMIT = 1000;

/**
 * The client-visible message for an unexpected `ApprovalPort.issueApproval` failure (INTERNAL 500). An
 * arbitrary port error (a store/DB failure, say) may carry internals, so only an error the port marked as
 * client-caused (`APPROVAL_ISSUE_ERROR_CODE`) has its own message shown; the original error still reaches
 * the observability hook via reportHostError.
 */
const APPROVAL_INTERNAL_ERROR_MESSAGE =
  "approval issuance failed; see the observability hook (onError) for details";

/** The 501 message for `POST /approvals` on a host that has not wired `authorizeGovernance`. */
const APPROVAL_AUTHORIZATION_REQUIRED_MESSAGE =
  "approval issuance requires an approver authorization: wire deps.authorizeGovernance to authorize the action.approve operation";

/** Audit / observability plane (/lineage, /analytics/summary, /telemetry). */
export function registerGovernanceRoutes(app: Hono, ctx: RouteContext): void {
  const { deps, getPrincipal, requireGovernance } = ctx;

  // --- Reading View Lineage (audit plane) ---
  app.get("/lineage", async (c) => {
    const denied = await requireGovernance(c, { kind: "lineage.read" });
    if (denied != null) return denied;
    const type = c.req.query("type");
    // Validate limit (reject NaN / negative / huge values, cap at 1000). Invalid / unspecified defers to the storage default.
    const limit = parseLimit(c.req.query("limit"), 1000);
    // type is comma-separated. Empty elements ("?type=" or "a,,b") carry no meaning, so drop them; if all are
    // empty, do not pass the type filter at all (no filter = all).
    const types =
      type != null
        ? type
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
    // since / until accept ISO8601 only + canonicalization (centralized in parseTimeWindow). The boundary
    // interpretation is identical to /analytics/summary (ts <= until; boundary inclusive), passed to LineageFilter.
    const range = parseTimeWindow(c);
    if (!range.ok) return range.error;
    const { since, until } = range;
    // The audit plane also filters by the session-derived (deps.tenant) tenant (symmetric with /promotions and
    // /fixations). Use the server-resolved tenant rather than the client-declared (query) one (impersonation
    // prevention). If unset, return all (legacy behavior).
    const tenant = await resolveTenant(c, deps);
    // Shared by both the default (tail-window) and order=asc (forward-paging) reads below; design.md #53.
    const filter: Omit<LineageFilter, "limit"> = {
      ...(types.length > 0 ? { type: types } : {}),
      ...(c.req.query("intentHash") != null ? { intentHash: c.req.query("intentHash")! } : {}),
      ...(c.req.query("artifactId") != null ? { artifactId: c.req.query("artifactId")! } : {}),
      ...(c.req.query("specHash") != null ? { specHash: c.req.query("specHash")! } : {}),
      ...(c.req.query("correlationId") != null ? { correlationId: c.req.query("correlationId")! } : {}),
      ...(since != null ? { since } : {}),
      ...(until != null ? { until } : {}),
      ...(tenant != null ? { tenant } : {}),
    };

    const order = c.req.query("order");
    if (order != null) {
      // order=asc (design.md #53): forward, append-order paging via StoragePort.pageLineage instead of the
      // default tail window below. Any other order value is a client error (only "asc" is defined); leaving
      // `order` unset entirely keeps the pre-existing response shape and behavior unchanged.
      if (order !== "asc") {
        return c.json(errorBody("BAD_REQUEST", 'order must be "asc"'), 400);
      }
      if (deps.compose.storage.pageLineage == null) {
        return c.json(
          errorBody("NOT_IMPLEMENTED", "forward paging (order=asc) is not supported by this storage backend"),
          501,
        );
      }
      const pageSize = parseLimit(c.req.query("pageSize"), 1000);
      const cursor = c.req.query("cursor");
      const pageReq: LineagePageRequest = {
        ...filter,
        ...(cursor != null ? { cursor } : {}),
        ...(pageSize != null ? { pageSize } : {}),
      };
      try {
        const page = await deps.compose.storage.pageLineage(pageReq);
        return c.json(page);
      } catch (e) {
        if (e instanceof LineageCursorError) {
          return c.json(errorBody("BAD_REQUEST", "cursor is invalid"), 400);
        }
        const requestId = requestIdOf(c, deps);
        await reportHostError(deps, "lineage", requestId, e);
        return c.json(
          errorBody(
            "INTERNAL",
            "lineage paging failed; see the observability hook (onError) for details",
            requestId,
          ),
          500,
        );
      }
    }

    const events = await deps.compose.storage.listLineage({
      ...filter,
      ...(limit != null ? { limit } : {}),
    });
    return c.json({ events });
  });

  // --- Usage analytics (overview of fallback rate / tier distribution / latency) ---
  // The audit plane (/lineage) only returns a raw event stream, so supply an operator-facing aggregate summary on a
  // separate route. The aggregation can be implemented with just listLineage reads (event schema unchanged,
  // read-only); authorization is analytics.read.
  app.get("/analytics/summary", async (c) => {
    const denied = await requireGovernance(c, { kind: "analytics.read" });
    if (denied != null) return denied;
    if (deps.analyticsSummarizer == null) {
      return c.json(errorBody("NOT_IMPLEMENTED", "analytics summarizer is not configured"), 501);
    }
    // since / until accept ISO8601 only + canonicalization (same rule as /lineage = parseTimeWindow).
    const range = parseTimeWindow(c);
    if (!range.ok) return range.error;
    const { since, until } = range;
    // limit: default 200 / max 1000 (same window limit as /lineage). Not a silent cap; the clamped value is stated explicitly in the response window.
    const limit = parseLimit(c.req.query("limit"), ANALYTICS_MAX_LIMIT) ?? ANALYTICS_DEFAULT_LIMIT;
    // Symmetric with the audit plane: the tenant is session-derived (server-resolved, not client-declared; impersonation prevention).
    const tenant = await resolveTenant(c, deps);
    // until must be applied before the storage tail slice; otherwise the latest limit events would all be excluded
    // by until and the window would be nearly empty. So pass until to listLineage and take the latest limit events
    // of window = [since, until] (the until post-filter in summarizeLineage remains as an idempotent safeguard).
    const events = await deps.compose.storage.listLineage({
      ...(since != null ? { since } : {}),
      ...(until != null ? { until } : {}),
      limit,
      ...(tenant != null ? { tenant } : {}),
    });
    // If storage returned exactly the window cap, indicate via truncated that older events may have fallen outside
    // the window (do not silently round the count. The UI states "the aggregation is based on the most recent N-event window").
    const truncated = events.length >= limit;
    const summary = deps.analyticsSummarizer(events, {
      ...(since != null ? { since } : {}),
      ...(until != null ? { until } : {}),
      ...(tenant != null ? { tenant } : {}),
    });
    return c.json({
      window: {
        limit,
        truncated,
        ...(since != null ? { since } : {}),
        ...(until != null ? { until } : {}),
        ...(tenant != null ? { tenant } : {}),
      },
      summary,
    });
  });

  // --- Telemetry (batch intake of rendered / component.used) ---
  app.post("/telemetry", async (c) => {
    const denied = await requireGovernance(c, { kind: "telemetry.write" });
    if (denied != null) return denied;
    const requestId = requestIdOf(c, deps);
    const body = await parseBody(c, TelemetryBodySchema, "events array required (max 500)");
    if (body instanceof Response) return body;
    // The telemetry path also resolves the tenant and stamps it onto records (consistent with the aggregation scope).
    const tenant = await resolveTenant(c, deps);
    for (const event of body.events) {
      // try/catch per event so that one record failure does not drop the remaining events. Failures are notified to the observability hook.
      try {
        if (event.kind === "rendered") {
          await deps.recorder?.rendered?.({
            specHash: event.specHash,
            surface: (event.surface ?? "web") as Surface,
            renderer: event.renderer ?? "unknown",
            ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
            ...(tenant != null ? { tenant } : {}),
          });
        } else {
          await deps.recorder?.componentUsed?.({
            artifactId: event.artifactId,
            surface: (event.surface ?? "web") as Surface,
            outcome: event.outcome ?? "ok",
            ...(event.sessionId != null ? { sessionId: event.sessionId } : {}),
            ...(tenant != null ? { tenant } : {}),
          });
        }
      } catch (e) {
        await reportHostError(deps, "telemetry", requestId, e);
      }
    }
    return c.json({ ok: true });
  });

  // --- Approval issuance for "approve"-tier governed Actions (design.md #63, SPEC ACT-APR-001 [Draft]) ---
  app.post("/approvals", async (c) => {
    if (deps.approvals == null) {
      return c.json(errorBody("NOT_IMPLEMENTED", "approvals are not configured for this host"), 501);
    }
    // SPEC ACT-APR-001 (e): issuing is a privileged act, so unlike the other governance routes it does not
    // fall back to "allowed when unwired" -- without the hook any authenticated principal other than the
    // requester could mint an approval.
    if (deps.authorizeGovernance == null) {
      return c.json(errorBody("NOT_IMPLEMENTED", APPROVAL_AUTHORIZATION_REQUIRED_MESSAGE), 501);
    }
    const requestId = requestIdOf(c, deps);
    const body = await parseBody(
      c,
      ApprovalRequestBodySchema,
      "action, payloadHash, and requesterId are required",
    );
    if (body instanceof Response) return body;
    // The body is parsed before authorizing so the hook can scope the grant to the action being approved
    // (`operation.action`): a role that may approve one action is not thereby an approver of every action.
    const denied = await requireGovernance(c, { kind: "action.approve", action: body.action });
    if (denied != null) return denied;
    const approver = await getPrincipal(c);
    // design.md #63: an approver must not be able to approve their own pending action. The ApprovalPort
    // itself also refuses this (defense in depth), but checking here first gives a clearer, dedicated
    // message rather than surfacing whatever generic error the port happens to throw.
    if (approver.id === body.requesterId) {
      return c.json(errorBody("BAD_REQUEST", "an approver cannot approve their own request"), 400);
    }
    const tenant = await resolveTenant(c, deps);
    try {
      const token = await deps.approvals.issueApproval(
        {
          action: body.action,
          payloadHash: body.payloadHash,
          requesterId: body.requesterId,
          approverId: approver.id,
          ...(tenant != null ? { tenant } : {}),
        },
        body.ttlSeconds != null ? { ttlSeconds: body.ttlSeconds } : undefined,
      );
      return c.json({ approval: token });
    } catch (e) {
      await reportHostError(deps, "approvals", requestId, e);
      if ((e as { code?: unknown } | null)?.code === APPROVAL_ISSUE_ERROR_CODE) {
        return c.json(errorBody("BAD_REQUEST", errorMessage(e), requestId), 400);
      }
      return c.json(errorBody("INTERNAL", APPROVAL_INTERNAL_ERROR_MESSAGE, requestId), 500);
    }
  });
}

/**
 * Validation + canonicalization of the since / until query (shared by /lineage and /analytics/summary). Accepts
 * ISO8601 only (see parseIso8601 for the acceptance rules and rationale), and on invalid input returns a
 * 400 response in error (the caller returns it as-is). Accepted values are normalized to ISO8601 canonical form
 * before returning (StoragePort compares strings lexicographically, so without canonicalization matches would be missed).
 */
function parseTimeWindow(
  c: Context,
): { ok: true; since?: string; until?: string } | { ok: false; error: Response } {
  const range: { since?: string; until?: string } = {};
  for (const key of ["since", "until"] as const) {
    const raw = c.req.query(key);
    if (raw == null) continue;
    const parsed = parseIso8601(raw);
    if (parsed == null) {
      return {
        ok: false,
        error: c.json(errorBody("BAD_REQUEST", `${key} must be an ISO8601 timestamp`), 400),
      };
    }
    range[key] = parsed;
  }
  return { ok: true, ...range };
}

/**
 * Only a plain decimal-digit string (with an optional decimal point) is accepted -- unlike a bare
 * `Number(raw)` conversion, this rejects hex ("0x10"), scientific notation ("1e3"), and numeric-separator
 * underscores ("1_000"), all of which `Number()` would otherwise silently accept as a value. This is the
 * isomorphic parity fix for the Python implementation's `_parse_limit`, whose `float(raw)` used to diverge
 * from `Number(raw)` on exactly these inputs (e.g. Python's `float("1_000")` is a valid 1000.0).
 */
const LIMIT_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Validation + clamping of the limit query (shared by /lineage and /analytics/summary; isomorphic to the Python
 * implementation's _parse_limit). NaN / negative / 0 / non-decimal-digit strings are invalid and return
 * undefined (defer to the caller's default); a positive value is floored and clamped to maxLimit
 * (preventing window bloat from huge values).
 */
export function parseLimit(raw: string | undefined, maxLimit: number): number | undefined {
  if (raw == null || !LIMIT_PATTERN.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? Math.min(Math.floor(n), maxLimit) : undefined;
}
