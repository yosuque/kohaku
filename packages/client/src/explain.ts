import {
  type CacheKeyParts,
  collectCapabilityScopes,
  type LineageEventRecord,
  type Scope,
  type UISpec,
} from "@kohaku-ui/spec-core";

/**
 * One L1/L2 generation attempt, as recorded on view.composed's `decision` summary (see @kohaku-ui/lineage's
 * ViewDecisionAttempt -- the client does not depend on lineage, so this is a narrow local mirror of its wire
 * shape).
 */
export interface ExplainDecisionAttempt {
  kind: "l1" | "l2";
  ok: boolean;
  issues?: string[];
}

/** One capability-negotiation downgrade (see @kohaku-ui/lineage's ViewDecisionDowngrade). */
export interface ExplainDecisionDowngrade {
  id: string;
  from: string;
  to: string;
  reason: string;
}

/** A view.composed event's `decision` summary (see @kohaku-ui/lineage's ViewComposedDecision). */
export interface ExplainDecision {
  attempts: ExplainDecisionAttempt[];
  downgrades?: ExplainDecisionDowngrade[];
  coalesced?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * One view.composed event's explain-facing fields, extracted from its lineage payload (see
 * @kohaku-ui/lineage's ViewComposedPayload). Every field but the always-present ones (eventId / ts /
 * intentHash / canonical / specHash / tier / cache) is only ever present on an event recorded after U2
 * shipped -- an older event (or a host with no correlationId wiring) simply omits it here too.
 */
export interface ExplainCompose {
  eventId: string;
  ts: string;
  intentHash: string;
  canonical: string;
  specHash: string;
  tier: string;
  cache: string;
  model?: string;
  correlationId?: string;
  generatorVersion?: string;
  kit?: { id: string; version: string };
  fallback?: { from: string; reason: string; kind?: "generation" | "negotiation" };
  cacheKey?: string;
  cacheKeyParts?: CacheKeyParts;
  decision?: ExplainDecision;
}

/**
 * The report `kohaku explain <requestId>` (and admin-react's DevTools) render: everything gathered for one
 * request's correlation id, built by {@link buildExplainReport} from the events {@link KohakuClient.explain}
 * fetched via `lineagePages({correlationId: requestId})`.
 */
export interface ExplainReport {
  /**
   * Every view.composed event found among `events`, oldest first. Usually exactly one entry -- but a
   * caller-supplied `X-Request-Id` is not guaranteed globally unique (a proxy that strips/rewrites it, a
   * caller that reuses ids, a retried request, ...), so this can legitimately hold more than one compose's
   * worth of data. A devtool should render each entry rather than assume a single result.
   */
  composes: ExplainCompose[];
  /**
   * Capability scopes implied by the Spec (`collectCapabilityScopes`), present only when the caller passed
   * one to `buildExplainReport` / `KohakuClient.explain`. Omitted (not merely `[]`) so "no Spec was given" is
   * distinguishable from "the Spec declares no scopes."
   */
  scopes?: Scope[];
  /** Every lineage event found for this requestId, in the order `lineagePages` returned them (append order). */
  events: LineageEventRecord[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value != null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function decisionOf(value: unknown): ExplainDecision | undefined {
  const d = asRecord(value);
  if (d == null) return undefined;
  const attempts = Array.isArray(d["attempts"]) ? (d["attempts"] as unknown[]) : [];
  return {
    attempts: attempts.flatMap((a) => {
      const rec = asRecord(a);
      const kind = rec?.["kind"];
      if (rec == null || (kind !== "l1" && kind !== "l2") || typeof rec["ok"] !== "boolean") return [];
      const issues = Array.isArray(rec["issues"])
        ? ((rec["issues"] as unknown[]).filter((i) => typeof i === "string") as string[])
        : undefined;
      return [{ kind, ok: rec["ok"] as boolean, ...(issues != null && issues.length > 0 ? { issues } : {}) }];
    }),
    ...(Array.isArray(d["downgrades"]) ? { downgrades: d["downgrades"] as ExplainDecisionDowngrade[] } : {}),
    ...(d["coalesced"] === true ? { coalesced: true as const } : {}),
    ...(asRecord(d["usage"]) != null
      ? { usage: d["usage"] as { inputTokens: number; outputTokens: number } }
      : {}),
  };
}

/** Extracts an ExplainCompose from one `view.composed` LineageEventRecord, or undefined if the payload is
 * missing a field this shape treats as required (a malformed/foreign record -- fail-open by omitting it
 * rather than throwing, since explain is a read-only reporting tool). */
function composeOf(event: LineageEventRecord): ExplainCompose | undefined {
  const p = asRecord(event.payload);
  const intentHash = asString(p?.["intentHash"]);
  const canonical = asString(p?.["canonical"]);
  const specHash = asString(p?.["specHash"]);
  const tier = asString(p?.["tier"]);
  const cache = asString(p?.["cache"]);
  if (
    p == null ||
    intentHash == null ||
    canonical == null ||
    specHash == null ||
    tier == null ||
    cache == null
  ) {
    return undefined;
  }
  return {
    eventId: event.id,
    ts: event.ts,
    intentHash,
    canonical,
    specHash,
    tier,
    cache,
    ...(asString(p["model"]) != null ? { model: asString(p["model"]) } : {}),
    ...(asString(p["correlationId"]) != null ? { correlationId: asString(p["correlationId"]) } : {}),
    ...(asString(p["generatorVersion"]) != null ? { generatorVersion: asString(p["generatorVersion"]) } : {}),
    ...(asRecord(p["kit"]) != null ? { kit: p["kit"] as { id: string; version: string } } : {}),
    ...(asRecord(p["fallback"]) != null
      ? { fallback: p["fallback"] as { from: string; reason: string; kind?: "generation" | "negotiation" } }
      : {}),
    ...(asString(p["cacheKey"]) != null ? { cacheKey: asString(p["cacheKey"]) } : {}),
    ...(asRecord(p["cacheKeyParts"]) != null ? { cacheKeyParts: p["cacheKeyParts"] as CacheKeyParts } : {}),
    ...(decisionOf(p["decision"]) != null ? { decision: decisionOf(p["decision"]) } : {}),
  };
}

/**
 * Pure function: builds an {@link ExplainReport} from a requestId's lineage events (typically gathered via
 * `KohakuClient.explain`'s `lineagePages({correlationId: requestId})` walk) plus, optionally, the composed
 * Spec itself (for the `scopes` field). Does not fetch anything itself -- kept pure so `kohaku explain`'s CLI
 * and admin-react's DevTools can both render from the identical shape without either depending on the other.
 */
export function buildExplainReport(events: LineageEventRecord[], spec?: UISpec): ExplainReport {
  const composes = events.filter((e) => e.type === "view.composed").flatMap((e) => composeOf(e) ?? []);
  return {
    composes,
    ...(spec != null ? { scopes: collectCapabilityScopes(spec) } : {}),
    events,
  };
}
