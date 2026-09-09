import {
  type ComposeContext,
  type ComposeResult,
  compose,
  type FixationCheck,
  materializeFixation,
  type TraceContext,
} from "@kohaku-ui/composer";
import type { CanonicalIntent, FixationRecord, SessionContext } from "@kohaku-ui/spec-core";

/**
 * Self-healing hooks for fixation staleness detection. Both the REST profile's FixationsApi and the
 * MCP profile's McpHostDeps.fixations conform to this shape structurally, so lineage's Fixations implementation
 * (the concrete class behind both) satisfies it as-is.
 *
 * options.tenant (tenant scoping) propagates to resolving the deletion/re-stamp target; a host that never resolves a
 * tenant (e.g. the MCP profile) simply never passes it.
 * options.guard (invalidate only): the fixation state observed at the moment stale was judged.
 * `ifRevision`, when the judged fixation carries one, takes priority over `ifFixatedAt` (a monotonic
 * per-write token that — unlike `fixatedAt`'s ms-precision ISO timestamp — distinguishes an unfixate → fixate
 * pair landing in the same millisecond). `ifFixatedAt` (always supplied by settleFixation as the fallback)
 * compares the fixation's `fixatedAt` timestamp, so a fixation re-approved between the judgment and the
 * delete call is never swept up even when it carries no catalog fingerprint or revision.
 * `ifCatalogFingerprint` additionally compares the catalog fingerprint when the fixation has one. If any of
 * these does not match the current fixation, the host must not delete it (TOCTOU guard).
 */
export interface FixationSelfHealApi {
  invalidate?(
    intentHash: string,
    reason: "stale",
    options?: {
      detail?: string;
      tenant?: string;
      guard?: { ifCatalogFingerprint?: string; ifFixatedAt?: string; ifRevision?: string };
    },
  ): Promise<void>;
  refreshFingerprint?(
    intentHash: string,
    catalogFingerprint: string,
    scope?: { tenant?: string },
  ): Promise<void>;
}

/** The two self-healing calls settleFixation may fire, named for the observability hook. */
export type FixationSelfHealEndpoint = "fixation.refreshFingerprint" | "fixation.invalidate";

/**
 * The host-supplied surface settleFixation / resolveFixatedResult / composeWithFixation need: the fixation
 * shortcut lookup, an optional delivery-admission gate (`admit`), the self-healing API, optional
 * per-(tenant, intentHash) serialization for the self-healing read-modify-write (host-rest wires the fixation
 * lock here; host-mcp-apps leaves it unset — the MCP profile neither resolves tenants nor guards against
 * unfixate/fixate interleaving), and an observability callback for self-healing failures.
 *
 * onSelfHealError is synchronous by design: the self-heal calls below are fire-and-forget (never awaited by
 * the delivery path), so the failure notification they trigger must also not be awaited here — a host that
 * wants to report asynchronously (e.g. writing to an audit log) does so by firing its own async call inside
 * this callback and letting it run to completion in the background (e.g. `void reportHostError(...)` /
 * `void reportMcpError(...)`).
 *
 * requestId (optional third parameter) carries the correlation id of the request that triggered self-healing
 * (settleFixation forwards whatever resolveFixatedResult/composeWithFixation were called with), so a host that
 * logs self-heal failures can tie them back to the triggering request. A host that has no notion of a request
 * id (e.g. the MCP profile, which mints none) simply ignores the parameter.
 */
export interface FixationDeliveryHost {
  lookup?: (intentHash: string, session: SessionContext) => Promise<FixationRecord | null>;
  /**
   * Delivery gate applied to a fixation `lookup` found (before it is checked for staleness). Both host
   * profiles' products previously duplicated a "serve this fixation only for the right session" policy (e.g.
   * language: pinned Specs were fixated from EN traffic, so serve EN sessions only) *inside* their own
   * `lookup`/`fixationLookup` callback. Centralizing that decision here instead lets a product keep `lookup`
   * as a plain fetch (e.g. delegating straight to `FixationsApi.get` / `StoragePort.getFixation`) and express
   * the policy once, shared by both REST and MCP wiring. Returning false is equivalent to `lookup` having
   * returned null (falls through to normal compose). Omitted = admit unconditionally (legacy behavior).
   */
  admit?: (fixation: FixationRecord, session: SessionContext) => boolean | Promise<boolean>;
  fixations?: FixationSelfHealApi;
  serialize?: <T>(
    scope: { tenant: string | undefined; intentHash: string },
    fn: () => Promise<T>,
  ) => Promise<T>;
  onSelfHealError(endpoint: FixationSelfHealEndpoint, error: unknown, requestId?: string): void;
}

/** Identity serialization used when a host does not wire a lock (e.g. the MCP profile). */
async function runUnserialized<T>(
  _scope: { tenant: string | undefined; intentHash: string },
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}

/**
 * Takes materializeFixation's staleness-check result, decides whether delivery is allowed, and fires
 * self-healing as a side effect. lineage recording cannot be done in the composer (dependency
 * direction), so it is done here in the host-core layer, shared by both host profiles.
 * - revalidated: re-stamp the current catalog fingerprint (fast-path next time). Delivery is not stopped even
 *   on failure; the self-heal call is fire-and-forget and its failure only reaches onSelfHealError.
 * - stale: invalidate the fixation and return null = the caller falls back to normal compose. Even if
 *   invalidate throws (e.g. deleteFixation is unimplemented), delivery continues (the fixation remains and
 *   runs degraded: revalidation fails every time -> fallback).
 */
export function settleFixation(
  materialized: { result: ComposeResult | null; check: FixationCheck },
  target: {
    intentHash: string;
    tenant: string | undefined;
    catalogFingerprint: string;
    fixation: FixationRecord;
  },
  host: FixationDeliveryHost,
  requestId?: string,
): ComposeResult | null {
  const { result, check } = materialized;
  const { intentHash, tenant, catalogFingerprint, fixation } = target;
  const fixations = host.fixations;
  const serialize = host.serialize ?? runUnserialized;

  if (result != null) {
    if (check.kind === "revalidated" && fixations?.refreshFingerprint != null) {
      // Self-healing (re-stamping the fingerprint) is performed against this tenant's fixation. Since
      // self-healing runs asynchronously from delivery, failures are not placed in the request's error
      // envelope but notified via onSelfHealError. Serialized under the host's (tenant, intentHash) lock (when
      // wired) so a get->put interleaving with the management-plane unfixate/fixate does not resurrect an
      // already deleted fixation.
      serialize({ tenant, intentHash }, () =>
        fixations.refreshFingerprint!(
          intentHash,
          catalogFingerprint,
          tenant != null ? { tenant } : undefined,
        ),
      ).catch((e) => {
        host.onSelfHealError("fixation.refreshFingerprint", e, requestId);
      });
    }
    return result;
  }

  // stale: not deliverable. Invalidate the fixation as self-healing (delivery continues via fallback).
  // Failures are notified via onSelfHealError rather than silently swallowed (delivery itself is not stopped).
  const detail = check.kind === "stale" ? check.issues.join("; ") : undefined;
  if (fixations?.invalidate != null) {
    // The stale verdict is about "the fixation at the time of judging." To avoid mistakenly deleting a new
    // fixation re-approved after the judgment, always pass the judged fixatedAt as a guard (conditional
    // deletion; this protects even legacy records with no catalogFingerprint), plus the catalog fingerprint
    // when the fixation has one, and serialize execution under the host's lock as well (when wired).
    serialize({ tenant, intentHash }, () =>
      fixations.invalidate!(intentHash, "stale", {
        ...(detail != null ? { detail } : {}),
        guard: {
          // Prefer the finer-grained revision token when the judged fixation carries one; fall back to
          // fixatedAt for records that predate it (invalidate's guard-check mirrors this same priority).
          ...(fixation.revision != null
            ? { ifRevision: fixation.revision }
            : { ifFixatedAt: fixation.fixatedAt }),
          ...(fixation.catalogFingerprint != null
            ? { ifCatalogFingerprint: fixation.catalogFingerprint }
            : {}),
        },
        ...(tenant != null ? { tenant } : {}),
      }),
    ).catch((e) => {
      host.onSelfHealError("fixation.invalidate", e, requestId);
    });
  }
  return null;
}

/**
 * Resolves the L0 fixation shortcut (L0 fixation = pinning an L1-generated spec down to a fixed L0 spec,
 * L1->L0). This is the single source of truth shared by composeWithFixation and any caller that needs the
 * fixation shortcut ahead of a streaming path (host-rest's /compose/stream). The structure is fixed while the
 * data stays fresh via $ref reference-passing. Assembling the fixated Spec/trace is centralized in
 * composer.materializeFixation (avoiding duplicating the normative logic). No fixation / stale (staleness
 * self-healing is fired by settleFixation) returns null, and the caller falls back to normal
 * compose / streaming generation.
 *
 * requestId, when passed, is forwarded to settleFixation so a self-heal failure notified via
 * host.onSelfHealError can be tied back to the triggering request (see FixationDeliveryHost's doc).
 */
export async function resolveFixatedResult(
  intent: CanonicalIntent,
  session: SessionContext,
  ctx: ComposeContext,
  host: FixationDeliveryHost,
  requestId?: string,
): Promise<ComposeResult | null> {
  const fixation = (await host.lookup?.(intent.hash, session)) ?? null;
  if (fixation == null) return null;
  if (host.admit != null && !(await host.admit(fixation, session))) return null;
  const materialized = await materializeFixation(fixation, intent, ctx, session.tenant);
  return settleFixation(
    materialized,
    {
      intentHash: intent.hash,
      tenant: session.tenant,
      catalogFingerprint: ctx.catalog.fingerprint,
      fixation,
    },
    host,
    requestId,
  );
}

/**
 * Fixation shortcut -> normal compose. ctx.materialize is the ComposeContext resolveFixatedResult validates
 * the fixation against (host-rest passes the tenant-scoped catalog here so revalidation matches the catalog
 * materializeFixation compares against under multi-tenant catalog splits; host-mcp-apps passes its single
 * ComposeContext). ctx.compose is the ComposeContext the normal-compose fallback runs against; when omitted it
 * defaults to ctx.materialize (the MCP profile has only one ComposeContext to begin with; the REST profile
 * passes its untenanted deps.compose here since compose() re-applies tenant/session internally).
 *
 * requestId, besides being forwarded to resolveFixatedResult's self-heal reporting, is also threaded into
 * the normal-compose fallback as ComposeOptions.correlationId — so a degraded/failed delivery's
 * observer.onError call and the resulting ComposeTrace both carry the same correlation id the caller (a
 * REST X-Request-Id, or an MCP tool call's JSON-RPC request id) already uses for its own logs.
 *
 * traceContext, when passed (host-rest's `traceparent` request header / host-mcp-apps' `_meta.traceparent`,
 * both already validated via this package's parseTraceContext), is threaded into the normal-compose
 * fallback as ComposeOptions.traceContext — additive/opt-in, same as correlationId above. The fixation
 * shortcut itself never calls compose(), so it has no use for traceContext.
 */
export async function composeWithFixation(
  intent: CanonicalIntent,
  session: SessionContext,
  ctx: { materialize: ComposeContext; compose?: ComposeContext; abort?: AbortSignal },
  host: FixationDeliveryHost,
  requestId?: string,
  traceContext?: TraceContext,
): Promise<ComposeResult> {
  const settled = await resolveFixatedResult(intent, session, ctx.materialize, host, requestId);
  if (settled != null) return settled;
  // Propagate the abort signal into normal compose's L1/L2 generation (the fixation shortcut never calls the LLM).
  return compose({ kind: "intent", intent }, ctx.compose ?? ctx.materialize, {
    session,
    ...(ctx.abort != null ? { abort: ctx.abort } : {}),
    ...(requestId != null ? { correlationId: requestId } : {}),
    ...(traceContext != null ? { traceContext } : {}),
  });
}
