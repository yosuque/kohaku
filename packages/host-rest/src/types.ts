import type { ComposeContext } from "@kohaku-ui/composer";
import type { ActionEffects, FixationSelfHealApi, ViewRecorder } from "@kohaku-ui/host-core";
import type {
  AuthzPort,
  DomainPort,
  FixationRecord,
  LineageEventRecord,
  Principal,
  SessionContext,
  UISpec,
} from "@kohaku-ui/spec-core";
import type { Context } from "hono";
import type { ComponentDraftInput } from "./routes/schemas.js";

/**
 * Recording hooks for View Lineage. Moved to host-core (`@kohaku-ui/host-core`'s `ViewRecorder`) so the MCP
 * profile can share the exact same contract instead of a narrower `onComposed`-only callback; re-exported here
 * for backward compatibility (existing imports of `ViewRecorder` from `@kohaku-ui/host-rest` keep working).
 */
export type { ComponentDraftInput, ViewRecorder };

/**
 * Management plane of the promotion pipeline (the structural type that @kohaku-ui/lineage's Promotions conforms to).
 * list/get are the side-effect-free read plane (optional = smooths the gap with older implementations).
 * approve/reject/withdraw are the fixed transitions. reviewer/actor are injected with the server-side principal.
 */
export interface PromotionsApi {
  /** Side-effect-free candidate list (no auto-nominate). Used by GET /promotions. scope.tenant narrows the aggregation. */
  list?(scope?: { tenant?: string }): Promise<unknown>;
  /**
   * Candidate list by status. Side-effect-free. Used by GET /promotions?status=.
   * optional = for a PromotionsApi that does not support listByStatus, filter the list result by status on the client side for compatibility.
   * scope.tenant narrows the aggregation.
   */
  listByStatus?(status: string, scope?: { tenant?: string }): Promise<unknown>;
  /**
   * Single fetch (null if it does not exist). Used by GET /promotions/:id and the 404 check.
   * When scope.tenant is specified, returns only candidates whose owning tenant matches (a mismatch returns null = treated as nonexistent for other tenants).
   */
  get?(artifactId: string, scope?: { tenant?: string }): Promise<unknown | null>;
  /** Auto-candidacy by usage-log threshold (has side effects). Used by POST /promotions/evaluate. scope.tenant narrows the aggregation. */
  evaluateAndList(scope?: { tenant?: string }): Promise<unknown>;
  // The trailing scope of single transitions (act/approve/reject/withdraw) carries the tenant used for the
  // owning-tenant check. Operations from a mismatched tenant do not see the candidate and are treated as
  // "nonexistent" (404 on the caller side). If deps.tenant is unset (single tenant), this is the legacy behavior.
  act(
    artifactId: string,
    action: Record<string, unknown>,
    actor: Principal,
    scope?: { tenant?: string },
  ): Promise<unknown>;
  approve(
    artifactId: string,
    draft: ComponentDraftInput,
    reviewer: Principal,
    scope?: { tenant?: string },
  ): Promise<unknown>;
  reject(artifactId: string, reviewer: Principal, scope?: { tenant?: string }): Promise<unknown>;
  withdraw(
    artifactId: string,
    actor: Principal,
    options?: { reason?: string; tenant?: string },
  ): Promise<unknown>;
  /**
   * Projection recovery from snapshot authority (#11), scanning across every tenant (no scope argument — it is
   * not a per-tenant operation). Used by `POST /promotions/reconcile`, an operator escape hatch to force
   * convergence on demand (the same recovery `@kohaku-ui/lineage`'s Promotions.reconcile already runs at
   * startup). optional = a PromotionsApi that does not implement it degrades to 501 NOT_IMPLEMENTED for that
   * one route, same idiom as `list?` / `get?` / `listByStatus?`.
   */
  reconcile?(): Promise<unknown>;
}

/**
 * Management plane of fixation (L1->L0) (the structural type that @kohaku-ui/lineage's Fixations conforms to).
 * `invalidate` / `refreshFingerprint` (the self-healing surface) are inherited as-is from host-core's
 * FixationSelfHealApi (also consumed by the MCP profile's McpHostDeps.fixations), so both hosts agree on the
 * exact same self-healing contract instead of maintaining two independently-drifting copies.
 */
export interface FixationsApi extends FixationSelfHealApi {
  proposals(scope?: { tenant?: string }): Promise<unknown>;
  list(scope?: { tenant?: string }): Promise<unknown>;
  fixate(args: { pinnedSpec: UISpec; approver: Principal; tenant?: string }): Promise<unknown>;
  unfixate(intentHash: string, approver: Principal, scope?: { tenant?: string }): Promise<void>;
  /**
   * Single fixation read by intentHash (optional). Lets `KohakuHostDeps.fixationLookup` be derived from this
   * management-plane API instead of requiring a product to wire a second, independent injection point for the
   * same read (e.g. reaching past `fixations` to call `StoragePort.getFixation` directly). When both this and
   * `fixationLookup` are wired, `fixationLookup` takes priority (backward compatible). A product that wants to
   * gate *which* sessions a found fixation is served to (e.g. by language) should do so via
   * `KohakuHostDeps.fixationAdmit` rather than filtering inside `get`, so the gate is shared with the MCP
   * profile's equivalent hook instead of being duplicated in both.
   */
  get?(intentHash: string, scope?: { tenant?: string }): Promise<FixationRecord | null>;
}

/**
 * Usage-analytics aggregator (the structural type that @kohaku-ui/lineage's summarizeLineage conforms to).
 * host-rest does not depend on lineage (staying loosely coupled via a structural type, like promotions / fixations),
 * so the concrete implementation (summarizeLineage) is injected by the product side (app.ts). It is a read-only pure
 * aggregation whose return value is JSON-ified as-is (host-rest does not prescribe the shape, receiving it as
 * unknown; the same idiom as PromotionsApi.list).
 */
export type LineageSummarizer = (
  events: LineageEventRecord[],
  opts: { tenant?: string; since?: string; until?: string; topIntentsLimit?: number },
) => unknown;

export interface KohakuHostDeps {
  compose: ComposeContext;
  domain: DomainPort;
  authz: AuthzPort;
  /** Allowed source for query:// (e.g. "sales"). Reference resolution for anything else is rejected. */
  querySource: string;
  /** Principal extraction (product responsibility). Defaults to a demo anonymous when omitted. */
  auth?: (c: Context) => Promise<Principal | null>;
  /**
   * Request -> tenant resolution (the multi-tenant contract; product responsibility). The resolved tenant is
   * placed on SessionContext.tenant and propagates to lineage recording, the promotion/fixation aggregation scope,
   * and the fixation shortcut.
   * When omitted, there is no tenant (equivalent to single tenant).
   * Invariant: query:// references are tenant-neutral and tenant is not mixed into the cache key (tenant narrowing
   * is done by DomainPort via principal / capability). Full isolation (RLS, etc.) is the product's responsibility.
   */
  tenant?: (c: Context) => Promise<string | undefined> | string | undefined;
  /**
   * Per-request correlation id resolution (product responsibility override; ops). Resolved once per request
   * and reused for the `X-Request-Id` response header, every error envelope's `error.requestId`, and the
   * `onError` observability hook, so a single id ties together everything logged about one request.
   * Default when omitted: the inbound `x-request-id` request header when present and well-formed (trimmed,
   * at most 128 characters, printable ASCII only), otherwise a fresh `randomUUID()`. A malformed inbound
   * header (too long, non-ASCII, empty after trimming) is discarded and replaced the same way as a missing one.
   */
  requestId?: (c: Context) => string;
  capabilityTtlSeconds?: number;
  /**
   * Overrides the request-body size cap (bytes) createKohakuRoutes applies via Hono's bodyLimit middleware
   * (ops; product responsibility). Default when omitted: 1 MiB (see routes.ts's DEFAULT_MAX_BODY_BYTES). A
   * product that already layers its own bodyLimit in front of the mount point (e.g. the sample host) can
   * leave this at the default — the two checks simply stack — or raise/lower it here to match.
   */
  maxBodyBytes?: number;
  /**
   * The L1->L0 fixation shortcut (supplied by @kohaku-ui/lineage; consulted before compose).
   * Receives SessionContext as its second argument, so it can resolve per-tenant fixations.
   * The legacy 1-argument lambda `(intentHash) => …` is still assignable as-is (a TS function type allows an implementation with fewer arguments).
   *
   * @deprecated Prefer wiring `fixations.get` (a plain read) plus `fixationAdmit` (a delivery-admission gate,
   * e.g. by language) instead of a single callback that conflates both concerns. When this is set it still
   * takes priority over `fixations.get` (backward compatible) and `fixationAdmit` is not consulted for it —
   * a product that migrates should fold its own gating logic out of this callback and into `fixationAdmit`.
   */
  fixationLookup?: (intentHash: string, session: SessionContext) => Promise<FixationRecord | null>;
  /**
   * Delivery-admission gate consulted, when set, after a fixation is found via `fixationLookup` /
   * `fixations.get` and before it is checked for staleness (host-core's `FixationDeliveryHost.admit`).
   * Lets a product express "serve this fixation only to the right session" (e.g. pinned Specs fixated from
   * EN traffic served to EN sessions only) once, instead of duplicating the check inside its own
   * `fixationLookup`/MCP `fixationLookup` implementations. Applies regardless of which of `fixationLookup` /
   * `fixations.get` supplied the fixation.
   */
  fixationAdmit?: (fixation: FixationRecord, session: SessionContext) => boolean | Promise<boolean>;
  recorder?: ViewRecorder;
  promotions?: PromotionsApi;
  fixations?: FixationsApi;
  /**
   * Usage-analytics aggregator (product responsibility; inject @kohaku-ui/lineage's summarizeLineage).
   * Used by GET /analytics/summary. **If not wired, 501 NOT_IMPLEMENTED** (the governance route still passes but the aggregation degrades).
   */
  analyticsSummarizer?: LineageSummarizer;
  /**
   * Side-effect declaration for writes (/binding/action) (optional). Called after domain.invoke, it returns the
   * `query://` URIs that the write invalidates (invalidates) and per-reference new versions (refVersions).
   * DomainPort is unmodified (the write itself is domain.invoke; the "declaration" of side effects is separated here).
   * If unset, the response is only `{result}` = fully backward compatible.
   */
  actionEffects?: ActionEffects;
  /**
   * Observability hook for failure paths (product responsibility; the implementation holds logs/metrics). The
   * composition handlers (/intent/normalize, /compose, /compose/stream, /events, /fixations/approve) call it before
   * converting an exception into an error envelope, passing endpoint, requestId, and the causing exception. The
   * requestId matches error.requestId of the same response, correlating logs with the client's error. Throws /
   * rejections from the hook are swallowed and do not propagate to the error response.
   * **If not wired, silent — no requestId is issued either (the legacy response is unchanged).**
   */
  onError?: (info: { endpoint: string; requestId: string; error: unknown }) => void | Promise<void>;
  /**
   * Authorization hook for the governance/audit plane (GET /lineage, POST /telemetry, /promotions*, /fixations*)
   * (product responsibility). If wired, it is checked on each governance route, and false rejects with 403
   * CAPABILITY_DENIED (no new error code is added; the SPEC §6.1 code set is preserved). operation.kind is the route
   * kind (e.g. "lineage.read" / "promotion.approve" / "fixation.remove"), and artifactId / intentHash are the target
   * identifiers (only on the relevant routes). tenant is the session-resolved tenant.
   * **If not wired, it is allowed without authorization (backward compatible). Governance-plane
   * authorization is a product responsibility, and since it becomes authorization-less when not wired, in
   * production either wiring this hook or protecting it with external middleware (a reverse proxy, etc.) is mandatory.**
   */
  authorizeGovernance?: (
    principal: Principal,
    operation: { kind: string; artifactId?: string; intentHash?: string },
    tenant?: string,
  ) => boolean | Promise<boolean>;
}
