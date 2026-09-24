import type { IntentInput } from "./intent.js";
import type { CanonicalIntent } from "./schema/intent.js";
import type { JsonObject, JsonValue } from "./schema/json.js";
import type { UISpec } from "./schema/spec.js";
import type { DataShape } from "./tabular.js";

/**
 * The Ports the framework defines and the product implements.
 * v0.1 extensions: SemanticPort.describeShape and StoragePort's lineage / promotion / fixation family.
 */

export interface Principal {
  id: string;
  name?: string;
  roles?: string[];
}

export type Surface = "web" | "chat" | "mcp-app" | (string & {});

export interface SessionContext {
  surface: Surface;
  sessionId?: string;
  principal?: Principal;
  locale?: string;
  /**
   * Tenant identifier (the multi-tenant contract). When specified, it propagates to lineage
   * recording, the aggregation scope of promotion/fixation, and the fixation short-circuit, so the
   * governance plane (lineage / promotion / fixation) is separated per tenant. If omitted, it is
   * equivalent to a single tenant (legacy behavior). **Not included in the cache key** (query://
   * references are tenant-neutral, and tenant filtering is done by DomainPort via
   * InvocationContext.principal / capability).
   */
  tenant?: string;
}

export type NLQuery = { kind: "nl"; text: string; locale?: string };
export type GuiAction = {
  kind: "gui";
  action: string;
  params: JsonObject;
  /** For an operation against an existing view, the Intent before the operation (the base for applying the diff). */
  current?: CanonicalIntent;
};
export type SemanticInput = NLQuery | GuiAction;

/** A data reference placed on a UI Spec. Bulk data is fetched by the component directly from the API. */
export interface QueryHandle {
  uri: string; // "query://source/path?params"
}

/** Exposure of the business API. Invariants remain behind this (in the domain module). */
export interface OperationDescriptor {
  name: string;
  description: string;
  /** JSON Schema (doubles as the semantic-layer document in the LLM prompt). */
  paramsSchema?: JsonValue;
  resultShape?: DataShape;
}

export interface InvocationContext {
  principal: Principal;
  capability?: string;
}

export interface DomainPort {
  listOperations(): Promise<OperationDescriptor[]>;
  invoke(op: string, args: JsonObject, ctx: InvocationContext): Promise<unknown>;
}

/**
 * Resolution of a normalized Intent → a deterministic query (the semantic-layer connection point).
 *
 * Tenant invariant: keep `query://` references tenant-neutral. Tenant data filtering is done by
 * DomainPort.invoke via InvocationContext.principal / capability, and resolveQuery / dataVersion do not
 * depend on the tenant. Therefore tenant is not included in the cache key, and Specs with the same
 * structure share the cache across tenants (any per-tenant catalog contribution separates them
 * naturally via catalogFingerprint).
 */
export interface SemanticPort {
  /**
   * Normalizes NL / GUI input. Returns an IntentInput without computing the hash: computing the
   * deterministic hash is the framework's responsibility (finalizeIntent), so implementers are not
   * forced to produce a dummy hash.
   */
  normalize(input: SemanticInput, ctx: SessionContext): Promise<IntentInput>;
  /**
   * Resolves a normalized Intent into a deterministic query (a reference-passing handle).
   * ctx.tenant (optional): because Intents added by promotion (publish) are independent per
   * tenant, it is used to look up per-tenant Intent definitions. query:// itself is tenant-neutral (the
   * invariant), so the URI of the returned QueryHandle does not depend on the tenant. Implementations
   * that ignore ctx (single-tenant) stay compatible as-is.
   */
  resolveQuery(intent: CanonicalIntent, ctx?: { tenant?: string }): Promise<QueryHandle | QueryHandle[]>;
  dataVersion(handle: QueryHandle): Promise<string>;
  /** Returns only column metadata (no row data). Used for chart-kind rules and props filling. */
  describeShape?(handle: QueryHandle): Promise<DataShape>;
}

/** Issuance and verification of on-behalf-of capability tokens. */
export interface Scope {
  kind: "read" | "write";
  /**
   * The allowed query:// URI (read) / action name (write). Matched by **exact equality**. Prefix
   * matching is not used because it creates value/name boundary escapes (`?region=us` permitting
   * `?region=usa`, action "x" permitting "xEvil"). Since the issuer fully enumerates the reachable
   * refs of a bind as variants (SPEC §5 A1), exact matching loses no expressiveness. Reserved
   * parameters (`_*`) are stripped back to the base ref before matching.
   */
  ref: string;
}

export interface VerifyRequest {
  kind: "read" | "write";
  ref: string;
}

export interface VerifyResult {
  ok: boolean;
  principal?: Principal;
  reason?: string;
}

/**
 * Default lifetime (seconds) of a capability token when the issuer is given no explicit TTL.
 * Shared by every AuthzPort implementation and by host-core's issuance helpers.
 */
export const DEFAULT_CAPABILITY_TTL_SECONDS = 600;

/**
 * Issuance and verification of on-behalf-of capability tokens (see `Scope`'s doc comment for the exact-match
 * contract). A concrete port may extend this with a `revokeCapability` method (see `CapabilityRevocationStore`
 * below); that extension is not part of the `AuthzPort` contract itself.
 */
export interface AuthzPort {
  issueCapability(principal: Principal, scopes: Scope[], opts?: { ttlSeconds?: number }): Promise<string>;
  /**
   * Verifies a capability token against a requested scope. A denial is a normal, expected outcome and MUST
   * be reported as `{ ok: false, reason }`, never thrown. `verify` MUST throw only on an infrastructure
   * failure it cannot itself classify as allow/deny (e.g. a revocation-store outage) -- and such a thrown
   * `verify` is fail-closed: the caller MUST treat it as a denial, and a host serving requests over this
   * port MUST map it to a 5xx response (never to a 2xx, and never to the same client-visible shape as an
   * `{ ok: false }` denial).
   */
  verify(token: string, req: VerifyRequest): Promise<VerifyResult>;
}

/**
 * Persistence for pre-expiry capability revocation. Not part of `AuthzPort` itself — revocation is
 * exposed as an extension method on a concrete port (e.g. `HmacAuthzPort.revokeCapability`), the same
 * way `storage-postgres` exposes `ready()` alongside `StoragePort`. A port's `verify` consults a store
 * like this one, keyed by the `jti` carried in its own token payload.
 *
 * This type lives here (spec-core), not in an adapter package, because it is a framework-boundary port
 * type consumed by multiple same-layer packages (authz-hmac, storage-redis, storage-postgres,
 * port-contracts): `spec/test/dependency-direction.test.ts` forbids a dependency on a same-or-later
 * layer, so defining it inside any one of them would make the others unable to depend on it.
 */
export interface CapabilityRevocationStore {
  /** Records jti as revoked until expiresAt (epoch seconds); the store may drop the entry after that. */
  revoke(jti: string, expiresAt: number): Promise<void>;
  /** Whether jti is currently revoked. Behavior after its expiresAt has passed is unspecified (the entry may or may not have been dropped). */
  isRevoked(jti: string): Promise<boolean>;
  close?(): Promise<void>;
}

/**
 * The result of revoking a capability (a concrete port's `revokeCapability` extension method, e.g.
 * `HmacAuthzPort`). Defined here (not in an adapter package) for the same reason as
 * `CapabilityRevocationStore`: it is a wire-shape type shared by multiple same-layer packages
 * (authz-hmac, port-contracts, and future AuthzPort implementations) that must not depend on one
 * another. `code` lets a caller branch on the failure kind without parsing `reason`; `alreadyExpired`
 * distinguishes "nothing to revoke, the token had already expired" from a genuine no-op success.
 */
export type RevokeCapabilityResult =
  | { ok: true; alreadyExpired?: true }
  | { ok: false; code: "MALFORMED" | "INVALID_SIGNATURE" | "NO_JTI" | "STORE_ERROR"; reason: string };

/** The persistence record for a lineage event (the strict schema is owned by @kohaku-ui/lineage). */
export interface LineageEventRecord {
  id: string;
  ts: string;
  actor: { kind: "user" | "model" | "system"; id?: string; model?: string };
  type: string;
  payload: Record<string, unknown>;
  tenant?: string;
}

export interface LineageFilter {
  type?: string[];
  artifactId?: string;
  specHash?: string;
  intentHash?: string;
  /** Only events at or after this time (ts >= since, inclusive). Assumes canonical ISO8601. */
  since?: string;
  /**
   * Only events at or before this time (ts <= until, inclusive). Assumes canonical ISO8601.
   * The upper bound paired with `since`, applied **before** the limit tail slice (otherwise the most
   * recent limit events would all be excluded by until and the window would be nearly empty). Returns
   * the most recent limit events in the window = [since, until].
   */
  until?: string;
  limit?: number;
  /**
   * Filter by tenant. When specified, returns only events whose tenant matches (after `normalizeTenant`
   * on both sides, so an empty-string tenant behaves like an omitted one and matches every event,
   * including old ones with no recorded tenant).
   */
  tenant?: string;
}

/**
 * Normalizes a tenant identifier: `undefined`, `null`, and `""` all collapse to `undefined`
 * ("unspecified"), everything else passes through unchanged. Every StoragePort tenant parameter (on
 * `PromotionState` / `FixationRecord` / `LineageFilter` and the get/put/list methods below) treats an
 * empty-string tenant as equivalent to omitting it; adapters MUST normalize with this helper before
 * using a tenant to key or filter a record, so `""` and `undefined` can never be keyed or filtered
 * inconsistently against each other.
 */
export function normalizeTenant(tenant?: string | null): string | undefined {
  return tenant == null || tenant === "" ? undefined : tenant;
}

/**
 * A snapshot of the promotion state. **The source of truth for reads is this snapshot** (design.md
 * §9.2). The lineage event log is the source of truth for auditing, but reconstructing state from
 * events (replay recovery) is not implemented, so StoragePort implementers must not mistake this
 * persistence for a "projection that can be reconstructed if lost" — the persistence of
 * putPromotionState / listPromotionStates is the ultimate state authority.
 */
export interface PromotionState {
  artifactId: string;
  status: string;
  updatedAt: string;
  data: Record<string, unknown>;
  /**
   * The tenant that owns the promotion state (the multi-tenant contract). If omitted, it is
   * tenant-neutral (equivalent to a single tenant). StoragePort keys state separation by this value as
   * (tenant, artifactId) (putPromotionState reads state.tenant). artifactId is derived from
   * sha256(content) and is unique across tenants, but status/verdict/draft are governance decisions and
   * progress independently per tenant (multiple tenants may promote the same artifact through their own
   * pipelines).
   */
  tenant?: string;
}

/** The record of L1→L0 fixation. Even with the structure fixed, data stays current via $ref reference-passing. */
export interface FixationRecord {
  intentHash: string;
  canonical: string;
  structureHash: string;
  pinnedSpec: UISpec;
  fixatedAt: string;
  approver: Principal;
  /**
   * The catalog fingerprint at fixation time (optional = compatible with the old fixations.json).
   * Used for staleness detection at materialize time: a fast path that skips revalidation when it
   * matches the current catalog's fingerprint; if it mismatches/is missing, revalidate pinnedSpec
   * against the current catalog.
   */
  catalogFingerprint?: string;
  /**
   * The tenant that owns the fixation (the multi-tenant contract). If omitted, it is tenant-neutral
   * (equivalent to a single tenant). StoragePort keys fixation separation by this value as
   * (tenant, intentHash) (putFixation reads record.tenant).
   */
  tenant?: string;
  /**
   * A per-write token, monotonic within this process (optional = compatible with old records with none). Finer
   * grained than `fixatedAt` (an ms-precision ISO timestamp), which cannot distinguish an unfixate → fixate
   * pair that lands inside the same millisecond. `fixate` stamps a fresh one on every write; the self-healing
   * TOCTOU guard (see `Fixations.invalidate`'s `guard`) compares this when present, falling back to
   * `fixatedAt` for records that predate this field.
   */
  revision?: string;
}

/**
 * The persistence target for cache / lineage / promotion state (RLS multi-tenancy, etc., are the product's choice).
 *
 * **Concurrency contract**: StoragePort itself carries no locking or versioning. Serializing the
 * read-modify-write of a given (tenant, key) — so that two concurrent writers cannot each read the same base
 * state and lose one another's update — is the **host's** responsibility, not the implementation's; the
 * reference host-rest does this with an in-process keyed mutex (`createKeyedMutex` in this package,
 * re-exported by `@kohaku-ui/host-core`, shared by the promotion lock and the fixation lock) and
 * host-mcp-apps wires the same mutex (keyed by
 * `intentHash` alone, since the MCP profile never resolves a tenant) into its fixation self-heal path. That
 * mutex only orders calls **within one process** — running multiple instances/processes against the same
 * backing store concurrently (e.g. two hosts sharing one data directory) is not supported by this contract;
 * a lost update between processes can still occur. The optional conditional-write parameters below
 * (`ifPresent` on `putFixation`) are additive hooks a StoragePort MAY use to narrow one specific race (a
 * stale self-heal resurrecting a fixation deleted by another writer); implementations that ignore them keep
 * unconditional (legacy) write behavior. A full compare-and-swap contract (arbitrary conditional writes across
 * all record kinds) is out of scope for v0.1 and left to future extension.
 */
export interface StoragePort {
  getSpecCache(key: string): Promise<UISpec | null>;
  putSpecCache(key: string, spec: UISpec, ttlSeconds?: number): Promise<void>;
  appendLineage(event: LineageEventRecord): Promise<void>;
  listLineage(filter?: LineageFilter): Promise<LineageEventRecord[]>;
  /**
   * Gets promotion state. When tenant is specified, returns only that tenant's state.
   * Old (legacy) state with no recorded tenant is treated as tenant-neutral and appears only in a
   * get with tenant unspecified. Storage without tenant support may ignore the 2nd argument, in which
   * case state is shared across tenants (fail-open; real tenant isolation is the product's
   * responsibility, e.g. RLS).
   */
  getPromotionState(artifactId: string, tenant?: string): Promise<PromotionState | null>;
  /** Saves promotion state. Reads state.tenant to key-separate as (tenant, artifactId) (signature unchanged). */
  putPromotionState(state: PromotionState): Promise<void>;
  /**
   * Saves several promotion states in one call (an optional v0.1 extension; performance only, no new
   * semantics over calling `putPromotionState` once per state). A batch nomination pass (e.g.
   * `nominateEligible` transitioning many candidates from `in_use` to `candidate` at once) would otherwise
   * re-read, re-stringify, and re-write the whole snapshot file once per candidate; a StoragePort that
   * implements this MAY instead fold every state into a single read-modify-write. Implementations that omit
   * it keep the legacy behavior (the caller falls back to looping `putPromotionState`), so this is purely
   * additive and never widens what a caller could already do without it.
   */
  putPromotionStates?(states: PromotionState[]): Promise<void>;
  /** Lists promotion states. When tenant is specified, only that tenant's (unspecified = all = legacy behavior). */
  listPromotionStates(tenant?: string): Promise<PromotionState[]>;
  /**
   * Gets a fixation. When tenant is specified, returns only that tenant's fixation.
   * Storage without tenant support may ignore the 2nd argument, in which case fixations are shared
   * across tenants (fail-open; real tenant isolation is the product's responsibility, e.g. RLS).
   */
  getFixation(intentHash: string, tenant?: string): Promise<FixationRecord | null>;
  /**
   * Saves a fixation. Reads record.tenant to key-separate as (tenant, intentHash).
   * `options.ifPresent` (optional, additive): when true, the write MUST be a no-op unless a fixation currently
   * exists at (record.tenant, record.intentHash) — used by self-healing's `refreshFingerprint` so a
   * get→put that races with a concurrent delete does not resurrect an already-removed fixation. An
   * implementation that ignores the second parameter keeps the legacy unconditional-write behavior (the
   * option narrows one race; it never widens what the caller could already do without it).
   */
  putFixation(record: FixationRecord, options?: { ifPresent?: boolean }): Promise<void>;
  /** Lists fixations. When tenant is specified, only that tenant's (unspecified = all = legacy behavior). */
  listFixations(tenant?: string): Promise<FixationRecord[]>;
  /**
   * Removes a fixation (an optional v0.1 extension). If unimplemented, unfixate fails (fail-fast; no
   * audit event is recorded either). When tenant is specified, deletes that tenant's fixation.
   */
  deleteFixation?(intentHash: string, tenant?: string): Promise<void>;
}

/** One event a machine-extracted schema suggestion believes a promotion candidate emits (`SchemaSuggestion.events` element). */
export interface SuggestedEvent {
  name: string;
  description: string;
}

/**
 * Wire shape of the `draft` a machine-extracted schema suggestion proposes. Structurally identical to
 * `@kohaku-ui/lineage`'s `ComponentDraft` (not imported: spec-core sits below lineage in the dependency
 * direction, so the shape is mirrored here — the same idiom `@kohaku-ui/client`'s own `ComponentDraft`
 * already uses for this wire contract).
 */
export interface SuggestedDraft {
  componentType: string;
  version: string;
  intentName: string;
  description: string;
  /** JSON Schema for the props (LLM-extracted or a human-entered draft). */
  paramsJsonSchema?: unknown;
  /** Data wiring for the promotion Intent: mapping of intent params -> query://. */
  queryTemplate?: {
    path: string;
    fixedParams?: Record<string, string>;
    paramMap?: Record<string, string>;
  };
}

/**
 * A machine-extracted registration proposal for a promotion candidate (advisory only; docs/design.md
 * §9.2 "Schema suggestion"). Produced by an extractor (`@kohaku-ui/evals`' `createSchemaExtractor`),
 * persisted on the promotion snapshot (`@kohaku-ui/lineage`'s `PromotionCandidate.suggestion`) so the
 * approval UI can prefill its form, and mirrored on the wire by `@kohaku-ui/client`'s
 * `SchemaSuggestionView`. Defined here, not in any one of those three packages, because it is a single
 * wire-contract type shared across same-layer packages that must not depend on one another (evals
 * produces it, lineage persists it, client mirrors it as a REST view) — the previous state had three
 * independently hand-maintained, structurally-identical definitions that could silently drift. Never
 * applied without a human `approve` carrying the final draft.
 */
export interface SchemaSuggestion {
  draft: SuggestedDraft;
  events: SuggestedEvent[];
  /** The extractor's own 0..1 estimate of how faithfully the proposal reflects the HTML. */
  confidence: number;
  /** The model that produced the proposal (LlmPort.modelId), for the audit trail. */
  model: string;
  /** Extractor identity + version, stamped like a rubric so a later prompt change is visible in lineage. */
  extractorId: string;
  extractorVersion: string;
  suggestedAt: string;
}

/**
 * The contribution of domain-specific components (a delta over the core catalog).
 * The concrete ComponentDefinition is owned by @kohaku-ui/registry (the generic parameter preserves the
 * dependency direction).
 */
export interface CatalogContribution<TDef = unknown> {
  components: TDef[];
}

/**
 * The known semantic design tokens. All optional; the defaults are owned by renderer-core's
 * defaultLightTheme / defaultDarkTheme (spec-core holds no values because it is environment-neutral).
 * This is just a "typed vocabulary" = a catalog for completion and type checking; unspecified keys fall
 * back to the default theme set.
 *
 * Status colors are minimized with a surface model of {solid, surface, text, border}.
 * `color.danger` / `color.focus` are deprecated aliases (resolving to color.negative / color.primary
 * respectively; handled by renderer-core's alias table) and have no concrete entry in the default theme
 * — so that spreading them does not break tracking of the target token.
 */
export interface KnownThemeTokens {
  /** Page/root background. Also used for knockout on fills (chart point strokes, etc.). */
  "color.background"?: string;
  /** The surface of cards, table headers, code blocks, loading, and the dialog body. */
  "color.surface"?: string;
  /** Borders and dividers. */
  "color.border"?: string;
  /** Headings and body text. */
  "color.text"?: string;
  /** Secondary text, help, captions, empty states, and axis labels. */
  "color.muted"?: string;
  /** The foreground on primary/negative fills (button text, etc.). */
  "color.on-primary"?: string;
  /** The brand primary color. Button fills, active tabs, focus. */
  "color.primary"?: string;
  /** Focus ring (reserved; aliases to color.primary if unset; v1 has no rendering-side consumer). */
  "color.focus"?: string;
  /** The emphasis solid for increase (rise) and metric deltas. */
  "color.positive"?: string;
  /** The surface of a success notification (toast success background). */
  "color.positive.surface"?: string;
  /** Success text readable on a light background (form success messages, etc.). */
  "color.positive.text"?: string;
  /** The border of a success notification. */
  "color.positive.border"?: string;
  /** The solid for decrease/danger, the danger button, and required marks. */
  "color.negative"?: string;
  /** The surface (background) of an error notification. */
  "color.negative.surface"?: string;
  /** The text of an error notification (readable on the surface). */
  "color.negative.text"?: string;
  /** The border of an error notification. */
  "color.negative.border"?: string;
  /** The surface (background) of a stale/warning notification. */
  "color.warning.surface"?: string;
  /** The text of a stale/warning notification. */
  "color.warning.text"?: string;
  /** The surface of an info notification (toast info background). */
  "color.info.surface"?: string;
  /** The text of an info notification. */
  "color.info.text"?: string;
  /** The border of an info notification. */
  "color.info.border"?: string;
  /** A deprecated alias (= color.negative). Kept for backward compatibility. */
  "color.danger"?: string;
  /**
   * The modal dialog backdrop (overlay.dialog's full-viewport scrim behind the box). Has its own
   * concrete light/dark value (unlike color.danger / color.focus, it is not an alias), but — like
   * color.danger / color.focus / chart.palette — is excluded from the L2 generation vocabulary
   * (composer's BuiltinTokenName): the sandbox never renders a dialog backdrop, so there is nothing
   * for the model to target with it.
   */
  "color.scrim"?: string;
  /** Chart axis lines, reference lines, grid, and ticks. */
  "chart.axis"?: string;
  /** Chart series colors (comma-separated CSV). */
  "chart.palette"?: string;
  // --- Non-color tokens (v2). Values are CSS strings with units; both renderers expand the same string inline. ---
  /** Sans-serif font stack for all UI text. */
  "font.family.sans"?: string;
  /** Monospace font stack (code, raw values). */
  "font.family.mono"?: string;
  /** Font size scale: xs (captions/ticks) → 2xl (KPI values). */
  "font.size.xs"?: string;
  "font.size.sm"?: string;
  "font.size.md"?: string;
  "font.size.lg"?: string;
  "font.size.xl"?: string;
  "font.size.2xl"?: string;
  /** Spacing scale (4px base): 1=4px … 6=32px. */
  "space.1"?: string;
  "space.2"?: string;
  "space.3"?: string;
  "space.4"?: string;
  "space.5"?: string;
  "space.6"?: string;
  /** Corner radii: sm (inputs/badges), md (buttons/notices), lg (cards/dialogs), full (pills). */
  "radius.sm"?: string;
  "radius.md"?: string;
  "radius.lg"?: string;
  "radius.full"?: string;
  /** Elevation shadows: sm (cards), md (dialogs/toasts). Dark themes use stronger values. */
  "shadow.sm"?: string;
  "shadow.md"?: string;
  /** Motion: duration and easing for hover/active transitions. */
  "motion.duration"?: string;
  "motion.easing"?: string;
}

/**
 * The brand. The Spec holds structure only, and tokens are resolved on the Renderer side.
 * Full backward compatibility is preserved with known keys (KnownThemeTokens, with completion) plus an
 * open index signature (also allowing product-specific tokens).
 */
export type ThemeTokens = KnownThemeTokens & Record<string, string | number>;
