import type { Surface } from "@kohaku-ui/spec-core";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import { TelemetryBodySchema } from "./schemas.js";
import { parseBody, type RouteContext, reportHostError, requestIdOf, resolveTenant } from "./shared.js";

/** Aggregation window for usage analytics. Default 200 / max 1000 (aligned with the /lineage window limits). */
const ANALYTICS_DEFAULT_LIMIT = 200;
const ANALYTICS_MAX_LIMIT = 1000;

/** Audit / observability plane (/lineage, /analytics/summary, /telemetry). */
export function registerGovernanceRoutes(app: Hono, ctx: RouteContext): void {
  const { deps, requireGovernance } = ctx;

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
    const events = await deps.compose.storage.listLineage({
      ...(types.length > 0 ? { type: types } : {}),
      ...(c.req.query("intentHash") != null ? { intentHash: c.req.query("intentHash")! } : {}),
      ...(c.req.query("artifactId") != null ? { artifactId: c.req.query("artifactId")! } : {}),
      ...(c.req.query("specHash") != null ? { specHash: c.req.query("specHash")! } : {}),
      ...(since != null ? { since } : {}),
      ...(until != null ? { until } : {}),
      ...(limit != null ? { limit } : {}),
      ...(tenant != null ? { tenant } : {}),
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
}

/**
 * ISO8601 validation + canonicalization of since / until. Date.parse broadly accepts non-ISO forms like
 * "July 9, 2026" and interprets them in the local TZ, making them environment-dependent, so restrict the format to
 * ISO8601 (extended notation). Values with a time require a timezone (Z / ±hh:mm) (an unspecified one is
 * non-deterministic under local interpretation). Date-only is interpreted as UTC (ES spec), which is deterministic.
 * The return value is ISO8601 canonical form. null if invalid.
 */
const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2}))?$/;
function parseIso8601(raw: string): string | null {
  if (!ISO8601_PATTERN.test(raw)) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
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
 * Validation + clamping of the limit query (shared by /lineage and /analytics/summary; isomorphic to the Python
 * implementation's _parse_limit). NaN / negative / 0 are invalid and return undefined (defer to the caller's
 * default); a positive value is floored and clamped to maxLimit (preventing window bloat from huge values).
 */
function parseLimit(raw: string | undefined, maxLimit: number): number | undefined {
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), maxLimit) : undefined;
}
