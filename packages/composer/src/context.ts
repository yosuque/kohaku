import type { LlmEffort, LlmPort } from "@kohaku-ui/llm";
import type { ResolvedCatalog, SurfaceCapabilities } from "@kohaku-ui/registry";
import {
  type CanonicalIntent,
  canonicalStringify,
  type DataShape,
  type JsonObject,
  type QueryHandle,
  type SemanticInput,
  type SemanticPort,
  type SessionContext,
  type StoragePort,
  sha256Hex,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { DesignSystemGuide } from "./design-system.js";
import type { PostRule } from "./post/types.js";
import type { ComposeTrace, TraceContext } from "./trace.js";

/** Supply source for L0 (fixed screens). canonical intent → fixed Spec template. */
export interface FixedSpecSource {
  lookup(
    intent: CanonicalIntent,
  ): Promise<UISpec | ((intent: CanonicalIntent, refs: QueryHandle[]) => UISpec) | null>;
}

export interface ComposePolicy {
  // Only "default" | "bypass" are supported: a "refresh" mode (force a miss while keeping the rest of
  // cache behavior) has no caller today, and adding it requires a matching enum addition to
  // provenance.cache, so it is left out until a real use case needs it.
  cacheMode?: "default" | "bypass";
  /**
   * How a Spec-cache backend failure (getSpecCache/putSpecCache throwing) is handled. Default "open":
   * the failure is reported to observer.onError with phase "cache" and treated as a lookup miss / a
   * skipped store, so a Spec is still delivered even when the cache backend is down. "closed" rethrows
   * the original error instead (compose fails), for callers that need the identical-display guarantee to
   * be strict rather than degrade silently.
   */
  cacheFailure?: "open" | "closed";
  /** Maximum number of repair "re-"attempts on L1 generation failure (default 1; combined with the initial generation, calls the LLM at most 2 times) */
  maxRepairAttempts?: number;
  fixedSpecs?: FixedSpecSource;
  /** Product-extension rules for deterministic post-processing (applied after the 4 standard rules) */
  extraRules?: PostRule[];
  /** When false (default), L1 failure = the deterministic fallback Spec with presentMarkdown */
  allowL2?: boolean;
  /** Routing such as skipping L1 and going directly to L2 depending on the intent */
  routeTier?: (intent: CanonicalIntent) => "L1" | "L2" | undefined;
  ttlSeconds?: number;
  /**
   * The generator version. When specified it becomes the 6th component of the cache key, separating
   * the cache by generation across prompt revisions and model changes. The default uses the composer's
   * defaultGeneratorVersion(llm). When unspecified it matches the conventional 5-component key exactly
   * (backward compatible).
   */
  generatorVersion?: string;
  /**
   * Candidate narrowing of the L1 generation vocabulary. Returns the component types to put on
   * the generation schema/prompt depending on the intent.
   * Returning undefined means all of them (default, safety valve). The guardrails (layout.stack / presentMarkdown) are always unioned by buildGenerationSchema.
   *
   * **Must be deterministic with respect to the intent** (always the same set for the same intent).
   *
   * An optional `id` may be attached to the function value (a function is an object; `Object.assign` a
   * plain function with `{ id: "..." }`, or declare it as `((intent, catalog) => ...) & { id?: string }`).
   * When present, `id` is folded into policyFingerprint (this module's `policyFingerprint`) so that
   * swapping to a different selectComponents implementation for the same policy shape automatically
   * separates the cache key; when absent it fingerprints as `"anonymous"` (not required — existing
   * callers that never set it see no change to the fingerprint or the cache key).
   */
  selectComponents?: ((intent: CanonicalIntent, catalog: ResolvedCatalog) => string[] | undefined) & {
    id?: string;
  };
  /**
   * The language of user-visible text in generated output (L1 heading titles, L2 widget text).
   * Inserted into the generation prompts as an "Output language" section. Default "English".
   * Changing it changes the prompt content — always bump generatorVersion (same rule as designSystem/fewShot).
   */
  outputLanguage?: string;
  /**
   * Supply good examples (few-shot) to L1 generation to self-reinforce (3-9). When specified, a
   * "examples of good composition" section is inserted into the generation prompt after the catalog and
   * before the instructions, making it easier for the LLM to imitate existing good compositions.
   * The validation pipeline (generation schema → catalog.validate → structural validation) is unchanged; few-shot only improves quality.
   */
  fewShot?: {
    /**
     * Supply of examples for an intent. Must be deterministic for the same intent (cache consistency).
     * on/off and supply-source changes alter the prompt content, so always bump generatorVersion.
     * A throw does not stop generation (l1-generate swallows it and treats it as empty).
     */
    examples(intent: CanonicalIntent): Promise<FewShotExample[]>;
    /** Injection cap (default 2) */
    maxExamples?: number;
    /**
     * An optional identifier for this few-shot supply source. When present, it is folded into
     * policyFingerprint (this module's `policyFingerprint`) so that swapping the example source for the
     * same policy shape automatically separates the cache key; when absent it fingerprints as
     * `"anonymous"` (not required — existing callers that never set it see no change).
     */
    id?: string;
  };
  /**
   * Cost/token budget guard. When specified, the budget is checked immediately before an LLM call
   * (before L1 generation, before repair, before L2), and on overage it skips L1 repair re-attempts and
   * L2 promotion and downgrades to the deterministic fallback (fallback.ts). The downgraded Spec is not
   * cached (it rides the non-persistence rule for fallbacks). A downgrade can be distinguished from
   * provenance.fallback's reason and observer.onError (ctx.budgetExceeded / reason).
   * **When unspecified, both behavior and performance are completely unchanged** (the budget-check code runs only when budget != null).
   */
  budget?: ComposeBudget;
  /**
   * Design-system application to L2 free generation (optional). When specified, a "design system" section
   * (token vocabulary + natural-language rules) is inserted into the L2 prompt, and the output is
   * contracted to write styles with token references var(--kohaku-*) (the values are injected by the
   * sandbox at render time — keeping theme independence: styles reference tokens rather than baking in
   * concrete color values, so cached output survives across light/dark and brand-theme swaps).
   * enforceTokenColors (default true) lints (L2_RAW_COLOR) raw color values back for repair.
   * **Changing the content and on/off alter the prompt content, so always bump generatorVersion**
   * (same rule as few-shot; this value is not included in the cacheKey). When unspecified, both behavior and output bytes are completely unchanged.
   */
  designSystem?: DesignSystemGuide;
  /**
   * Pre-delivery smoke validation of L2-generated HTML (optional). Called after the static lint
   * (collectL2Issues) passes; if the return value is non-empty it is sent back as repair issues
   * ([] = pass). A throw is fail-open (skip the check = conventional behavior; same style as the budget
   * hook — a validator fault does not stop L2 delivery).
   * When not wired, behavior is completely unchanged. The implementation is provided by createL2Smoke() of @kohaku-ui/sandbox/smoke (wiring is the app's responsibility).
   */
  l2Smoke?: (html: string, ctx: { ref?: string; shape?: DataShape }) => Promise<string[]>;
  /**
   * How `data.$ref` on L1-generated components is constrained to the resolved QueryHandle set
   * (SPEC §4's "MUST be constrained ... at the schema stage or the validation stage"). Default `"schema"`
   * (unchanged conventional behavior): `buildL1GenerationSchema` pins `data.$ref` to an enum of the
   * resolved reference URIs, so an out-of-set reference is structurally impossible for a provider honoring
   * the schema (native structured-output mode).
   *
   * `"validate"`: the generation schema instead leaves `data.$ref` as a plain string (no enum), and
   * `generateL1`'s `collectIssues` explicitly checks set-membership after generation, sending a
   * `DATA_REF_UNRESOLVED` repair issue back into the loop when a reference falls outside the resolved set.
   * Trades the schema-level guarantee for an intent-*independent* generation grammar: because the enum's
   * contents are a function of the resolved reference set (which differs per Intent), a schema-based
   * provider that compiles/caches output grammars (observed: Anthropic's structured-output grammar
   * compilation) recompiles on every distinct Intent under `"schema"`, whereas a `"validate"` grammar is
   * the same shape across every Intent (candidate narrowing aside) and can be reused. Measure before
   * switching the default — see `apps/sample-api/scripts/measure-grammar-latency.ts` and docs/design.md §5.
   *
   * Included in `policyFingerprint` (only when set to `"validate"` — the default value is indistinguishable
   * from unset, so it never changes an existing cache key) because it changes the generation schema
   * actually sent to the LLM, which can change the generated output for the same Intent.
   */
  refConstraint?: "schema" | "validate";
  /**
   * Per-tier Adaptive Reasoning effort (`@kohaku-ui/llm`'s `LlmEffort`), threaded to the L1 constrained
   * generation call (`tiers/l1-generate.ts`) and the L2 free-form HTML call (`tiers/l2-generate.ts`)
   * respectively as `GenerateObjectRequest`/`GenerateTextRequest.effort`. `l1`/`l2` are independent: L1 is
   * constrained catalog selection (usually cheap to reason about) while L2 is free-form generation (may
   * benefit from more effort) — an operator can set either, both, or neither. A tier left unset sends no
   * `effort` at all for that call (provider default; identical to this field never existing). A port that
   * does not implement effort control (FakeLlm/FixtureLlm, or a provider `adapters/ai-sdk.ts` has no
   * matching option for) ignores it.
   *
   * Included in `policyFingerprint` whenever this object is set (any `l1`/`l2` combination, including both
   * left unset) because effort can change the generated output for the same Intent/model. **When
   * unspecified, `policyFingerprint` and the cacheKey are completely unchanged** (same contract as
   * `refConstraint` above).
   */
  effort?: { l1?: LlmEffort; l2?: LlmEffort };
}

/**
 * Configuration of the cost/token budget guard. The check runs immediately before an LLM call, and
 * on rejection it skips subsequent LLM calls (L1 repair re-attempts, L2 promotion) and downgrades to the
 * deterministic fallback. **The budget is a "threshold that stops additional calls," not a cap on a
 * single call** (an LLM's output size cannot be determined in advance, so an initial/single call that
 * exceeds the budget by a wide margin cannot be stopped — the overage is recorded after the fact in
 * trace.usage). L0 (fixed Spec) and cache hits do not call the LLM, so they are out of scope (passed
 * through). perCompose and check can be combined (a rejection from either one causes a downgrade).
 */
export interface ComposeBudget {
  /**
   * **A cumulative token threshold that stops additional LLM calls** (not a hard cap on total tokens).
   * The check runs immediately before each LLM call, based on whether the accumulated usage of the
   * attempts so far (sum of inputTokens + outputTokens) has reached this value, and if it has, subsequent
   * LLM calls are skipped. Because an LLM's output size cannot be determined in advance, a single call
   * that exceeds this value by a wide margin cannot be stopped beforehand (the overage is merely recorded
   * after the fact in trace.usage).
   * stopAfterTokens: 0 means "zero budget = generate nothing at all" (does not even call the initial L1).
   */
  perCompose?: { stopAfterTokens: number };
  /**
   * A global budget hook supplied by the product. Called before each LLM call (before L1 generation,
   * before repair, before L2), and returning allow:false skips the LLM call at that point and downgrades
   * to the fallback. Holding state such as a daily budget or per-tenant budget is the product's
   * responsibility — the framework does not decide where it is held. Must be a **side-effect-free
   * idempotent read** (it may be called multiple times during one compose). A throw is swallowed and
   * passed through (allow) — so that we do not drop every UI to a fallback when the budget state cannot
   * be determined. The fail-open occurrence can be observed via observer.onBudgetCheckError (a throw is
   * merely swallowed, not left unobserved).
   * When allow:false, reason is placed on fallback.reason (a default message if unspecified).
   */
  check?: () => { allow: boolean; reason?: string };
  /**
   * **A wall-clock deadline for one whole `compose`/`composeStream` call**, in milliseconds elapsed since
   * the compose started (`PreparedCompose.startedAt`). A sibling of `perCompose`/`check` above but measuring
   * time instead of tokens: checked at the exact same points (immediately before L1 generation, before each
   * repair re-attempt, before L2), and armed once for the whole L1→L2 ladder rather than re-measured from
   * zero per attempt — so it bounds the *compose*, not any single LLM call. On expiry it downgrades to the
   * deterministic fallback exactly like a `perCompose` token overage (`ctx.budgetExceeded: true`, `reason`
   * distinguishable from the token-budget reason by mentioning "deadline" rather than "token threshold").
   *
   * **This is checked between calls, and additionally aborts a call that is already in flight** when the
   * deadline elapses mid-call (see `createDeadlineGuard` in budget.ts): the resulting `LlmError` (code
   * `ABORTED`) is classified as this same deadline-budget fallback, not as a client cancellation — an
   * operator-configured deadline must count toward the generation-fallback rate an operator watches, unlike
   * an actual caller `AbortSignal`/client disconnect (see docs/design.md §5's "Client aborts are
   * distinguished from generation fallbacks" and its "Compose-wide deadline" subsection for the full
   * rationale and how the two abort sources are told apart).
   *
   * **When unspecified, behavior and performance are completely unchanged** (no timer is armed, no extra
   * `Date.now()` call is made, and the abort signal passed to LLM calls is `ComposeOptions.abort` verbatim).
   */
  deadlineMs?: number;
}

/**
 * One example to inject into few-shot (3-9). For the sake of the prompt budget, it does not carry
 * provenance / dataVersion etc., only the normalized Intent and the skeleton of components / events.
 */
export interface FewShotExample {
  intent: { canonical: string; params: JsonObject };
  spec: Pick<UISpec, "components" | "events">;
}

/**
 * The context passed to the observation hook on a compose failure. So that it can be called even
 * at stages where the trace is not yet finalized (normalize / reference-resolution failures), everything
 * except phase / input is optional. The implementation holds logs/metrics; the composer merely opens the hook.
 */
export interface ComposeErrorContext {
  /**
   * "hard" = compose threw an exception (no Spec delivered). Corresponds to normalize / reference-resolution / final-validation failures.
   * "fallback" = L1/L2 became ok:false and fell to the deterministic downgrade Spec (a Spec is delivered but generation failed).
   * "cache" = the Spec cache backend (getSpecCache/putSpecCache) threw. Fail-open by default (policy.cacheFailure): the
   * lookup is treated as a miss / the store is skipped and a Spec is still delivered; set to "closed" to rethrow instead.
   * "cancelled" = the same deterministic-downgrade path as "fallback", but the cause was the caller's
   * AbortSignal firing (a client disconnect/timeout) rather than an actual generation failure. Hosts use
   * this to skip lineage recording (view.composed/view.fallback) so cancels do not inflate the fallback-rate analytics.
   */
  phase: "hard" | "fallback" | "cache" | "cancelled";
  input: SemanticInput | { kind: "intent" };
  intent?: CanonicalIntent;
  cacheKey?: string;
  /** The stage that failed (to the extent known). Unset on normalize / reference-resolution failures. */
  tier?: "L1" | "L2";
  /** The reason for the fallback (matches buildFallbackSpec's reason). Unset on hard. */
  reason?: string;
  /**
   * True when the downgrade is due to the budget guard. Set when a perCompose overage or a check
   * rejection skipped L1 repair re-attempts and L2 promotion and fell to the deterministic fallback.
   * Unset for a normal generation-failure fallback.
   * An additive field for machine-distinguishing a budget downgrade without relying on string-matching reason (phase="fallback" only).
   */
  budgetExceeded?: boolean;
  /**
   * The caller-supplied correlation id (ComposeOptions.correlationId), threaded through unchanged so a
   * degradation reported here can be tied back to the triggering request (e.g. host-rest's X-Request-Id /
   * error.requestId, or an MCP tool call's JSON-RPC request id). Unset when the caller passed none — a
   * purely additive, opt-in field (compose's default behavior and every existing observer are unaffected).
   */
  correlationId?: string;
  /**
   * The caller-supplied W3C trace context (ComposeOptions.traceContext), threaded through unchanged (same
   * additive/opt-in contract as correlationId above) so an OTel observer (see @kohaku-ui/otel) can record
   * the failed/degraded compose as a child of the caller's own trace. See TraceContext's doc comment.
   */
  traceContext?: TraceContext;
}

/**
 * The context passed to the observation hook when the budget hook check() threw and fail-open occurred
 * (passed through = generation continued). Unlike onError, **this is not a compose failure**
 * (generation continues and a Spec may be delivered normally). A dedicated channel for machine-distinguishing,
 * monitoring, and remediating a budget-hook fault. tier indicates the LLM-call stage at which the throw occurred.
 */
export interface BudgetCheckErrorContext {
  input: SemanticInput | { kind: "intent" };
  intent: CanonicalIntent;
  cacheKey: string;
  /** The LLM-call stage at which the budget hook threw (L1 generation/repair or L2 promotion decision). */
  tier: "L1" | "L2";
}

export interface ComposeObserver {
  onComposed?(trace: ComposeTrace, spec: UISpec): void | Promise<void>;
  /**
   * Notifies of a compose failure (observation-only, backward-compatible optional). Like onComposed it is
   * fire-and-forget, and a throw / reject does not propagate to the compose body's error or result
   * (the composer swallows it).
   * - hard failure: passes the causing exception to error via the exception-throwing path.
   * - fallback failure: a deterministic downgrade on generation failure where error is undefined (the reason is ctx.reason). Once per generation.
   */
  onError?(ctx: ComposeErrorContext, error: unknown): void | Promise<void>;
  /**
   * Notifies that a throw from the budget hook check() was swallowed as fail-open (observation-only,
   * additive). **This is not a failure notification**: generation continues and a Spec may be
   * delivered normally afterward (a separate channel from onError). A machine-distinguishable hook so
   * that a state where the budget hook is broken and every UI is passed through is not left unobserved.
   * Like onError it is fire-and-forget (a throw / reject is swallowed by the composer). It may be called
   * multiple times during one compose (each time a throw occurs before L1 generation, before repair, or before L2).
   */
  onBudgetCheckError?(ctx: BudgetCheckErrorContext, error: unknown): void | Promise<void>;
}

export interface ComposeContext {
  catalog: ResolvedCatalog;
  /**
   * Resolution of a per-tenant catalog (optional). Because components added by promotion (publish)
   * are independent per tenant, passing this makes compose / composeStream do generation, validation, and
   * cache-key computation with session.tenant's catalog.
   * When unspecified it always uses `catalog` (single, tenant-neutral) (conventional behavior). A
   * per-tenant catalog has a different fingerprint, so cache keys separate naturally (compatible with the
   * invariant that query:// is tenant-neutral).
   * The returned catalog must be deterministic (the same tenant gets a catalog with the same fingerprint).
   */
  catalogFor?: (tenant?: string) => ResolvedCatalog;
  semantic: SemanticPort;
  storage: StoragePort;
  llm: LlmPort;
  /**
   * Per-tier LlmPort override (optional, additive). `llm` above stays required and is the fallback for
   * any tier not overridden here — so a ComposeContext that never sets `llmByTier` resolves every tier to
   * `llm`, identically to before this field existed. Lets an operator plug a small fine-tuned model (see
   * `kohaku dataset export`, aimed at exactly the L1 constrained-generation task) into L1 while keeping a
   * larger model for L2's free-form generation, or vice versa. Resolved per tier at the point of dispatch
   * (`resolveTierLlm`, called from `tiers/l1-generate.ts` / `tiers/l2-generate.ts`).
   *
   * Cache-key correctness: the identity (provider+modelId) of the models actually used per tier is folded
   * into `policyFingerprint`'s extra material (`tierLlmFingerprintMaterial`, computed by `compose.ts` from
   * this field) **only when at least one set tier's provider/modelId differs from `llm`'s** — so wiring
   * `llmByTier` with entries that happen to match the base model changes nothing, and leaving it unset is
   * always byte-identical to before. `defaultGeneratorVersion` (prompt.ts) deliberately stays derived from
   * the base `llm` only; the fingerprint, not generatorVersion, is what separates the cache when per-tier
   * models diverge — see `defaultGeneratorVersion`'s doc for the full rationale.
   */
  llmByTier?: { L1?: LlmPort; L2?: LlmPort };
  /** When specified, also performs capability negotiation (negotiate) after compose */
  surface?: SurfaceCapabilities;
  policy?: ComposePolicy;
  /**
   * Per-session policy resolution (optional). Resolved exactly once at the entry of
   * compose / composeStream (after withTenantCatalog); returning undefined keeps `policy`.
   * Must be deterministic with respect to the session fields it reads (e.g. locale), and any
   * variation that changes prompt content MUST be reflected in the returned policy's
   * generatorVersion (same rule as outputLanguage / fewShot / designSystem) — the cache key
   * has no session component of its own.
   */
  policyFor?: (session?: SessionContext) => ComposePolicy | undefined;
  observer?: ComposeObserver;
}

/**
 * Returns a ComposeContext with the catalog swapped for session.tenant's (if catalogFor is not wired,
 * returns ctx as-is). The storage reference is retained (the single-flight in-flight table is keyed by
 * storage, so the swap does not scatter it into a different bucket). Resolved once at the entry of
 * compose / composeStream so that all downstream `ctx.catalog` references automatically see the tenant's
 * catalog (the signatures of downstream functions are unchanged).
 */
export function withTenantCatalog(ctx: ComposeContext, tenant?: string): ComposeContext {
  if (ctx.catalogFor == null) return ctx;
  return { ...ctx, catalog: ctx.catalogFor(tenant) };
}

/**
 * Resolves the LlmPort to actually use for one tier: `ctx.llmByTier[tier]` when `llmByTier` is set and
 * that tier is present, otherwise the required base/fallback `ctx.llm`. Purely additive — a ComposeContext
 * that never sets `llmByTier` resolves every tier to `ctx.llm`, identically to before this function
 * existed. Called from `tiers/l1-generate.ts` / `tiers/l2-generate.ts` at the point each tier's LLM call is
 * dispatched.
 */
export function resolveTierLlm(ctx: ComposeContext, tier: "L1" | "L2"): LlmPort {
  return ctx.llmByTier?.[tier] ?? ctx.llm;
}

/** The extra `policyFingerprint` material contributed by `ComposeContext.llmByTier` — see `tierLlmFingerprintMaterial`. */
export interface TierLlmFingerprintMaterial {
  l1?: { provider: string; modelId: string };
  l2?: { provider: string; modelId: string };
}

/**
 * Computes the extra `policyFingerprint` material for `ctx.llmByTier` (see that field's own doc on
 * `ComposeContext`). Returns undefined — meaning "contribute nothing, cacheKey unaffected" — whenever
 * `llmByTier` is unset, or whenever every tier it does set resolves to the same `provider`/`modelId` as the
 * base `ctx.llm` (no actual generation difference to separate the cache for). Only when at least one set
 * tier's model genuinely differs from the base does this return the `{provider, modelId}` pairs for the
 * tiers `llmByTier` sets (a tier `llmByTier` never touched contributes nothing of its own — it already
 * generates with the same `ctx.llm` the rest of the cache key's generatorVersion/fingerprint story covers).
 */
export function tierLlmFingerprintMaterial(ctx: ComposeContext): TierLlmFingerprintMaterial | undefined {
  if (ctx.llmByTier == null) return undefined;
  const base = { provider: ctx.llm.provider, modelId: ctx.llm.modelId };
  const differsFromBase = (llm: LlmPort | undefined): boolean =>
    llm != null && (llm.provider !== base.provider || llm.modelId !== base.modelId);
  if (!differsFromBase(ctx.llmByTier.L1) && !differsFromBase(ctx.llmByTier.L2)) return undefined;
  const material: TierLlmFingerprintMaterial = {};
  if (ctx.llmByTier.L1 != null) {
    material.l1 = { provider: ctx.llmByTier.L1.provider, modelId: ctx.llmByTier.L1.modelId };
  }
  if (ctx.llmByTier.L2 != null) {
    material.l2 = { provider: ctx.llmByTier.L2.provider, modelId: ctx.llmByTier.L2.modelId };
  }
  return material;
}

/**
 * Returns a ComposeContext with the policy swapped for the session's (if policyFor is not wired or
 * returns undefined, returns ctx as-is — byte-identical behavior). Resolved once at the entry of
 * compose / composeStream, after withTenantCatalog and before prepareCompose, so that the cache key
 * (which reads policy.generatorVersion) and every downstream `ctx.policy` read see the session policy.
 */
export function withSessionPolicy(ctx: ComposeContext, session?: SessionContext): ComposeContext {
  if (ctx.policyFor == null) return ctx;
  const policy = ctx.policyFor(session);
  return policy != null ? { ...ctx, policy } : ctx;
}

/**
 * The entry-point context resolution shared by compose and composeStream: swap to the tenant's catalog and
 * the session's policy, then layer the caller's policyOverride on top, in that order (withTenantCatalog →
 * withSessionPolicy → policyOverride). Must happen before prepareCompose — the cache key reads
 * policy.generatorVersion. No transform if none of the corresponding hooks/options are wired
 * (byte-identical behavior).
 *
 * policyOverride is applied last and shallow-merged onto the already-resolved policy so that a
 * caller-level policy decision (recompose's respectPrevTier routing to L2, for instance) survives even
 * when ctx.policyFor is wired — otherwise withSessionPolicy's wholesale `policy` replacement would
 * silently discard it. The spread order (`...policy, ...policyOverride`) keeps every other field the
 * session policy resolved (generatorVersion included) while only the overridden keys change.
 */
export function resolveEntryContext(
  baseCtx: ComposeContext,
  opts: { session?: SessionContext; policyOverride?: Partial<ComposePolicy> },
): ComposeContext {
  const ctx = withSessionPolicy(withTenantCatalog(baseCtx, opts.session?.tenant), opts.session);
  if (opts.policyOverride == null) return ctx;
  return { ...ctx, policy: { ...ctx.policy, ...opts.policyOverride } };
}

// ResolvedRefs / ResolvedHandleVersions / resolveHandleVersions moved to refs.ts (alongside
// compose.ts's former resolveRefs, which shares this exact resolution sequence). Re-exported here so
// index.ts's public surface (which imports ResolvedRefs from "./context.js") is unchanged.
export type { ResolvedRefs } from "./refs.js";

/**
 * A canonical fingerprint (16 hex characters) of the ComposePolicy fields that change prompt content but
 * were, until now, only enforced by the operational convention of bumping `generatorVersion` by hand
 * (outputLanguage / designSystem / fewShot's supply source / selectComponents' narrowing function) — see
 * each field's own doc comment above. prepareCompose (compose.ts) feeds the result into
 * spec-core's `cacheKey` as the 7th component, so a policy shape that actually varies one of these fields
 * separates the cache automatically, without relying on every caller remembering the manual bump.
 *
 * **Returns the empty string when none of the five fields are set to a non-default value** (`policy` is
 * the "classic" shape with no fingerprinted field at all) — spec-core's `cacheKey` treats an empty
 * policyFingerprint exactly like an omitted one, so a policy that never touches these fields produces a
 * cache key byte-identical to before this function existed (no existing cache entry is invalidated by
 * introducing it).
 *
 * fewShot / selectComponents are functions (their actual behavior cannot be inspected), so only their
 * optional `id` participates (default `"anonymous"` when unset — not required, so existing callers that
 * never set `id` see no change in the fingerprint they already had). designSystem folds in a fixed pick of
 * fields — `tokens`, `guidelines`, `enforceTokenColors` — plus two design-kit fields added by Task 7b:
 * `kit` folds in the whole object whenever set (a different `id`, `version`, `classes`, `utilities`,
 * `namespaces` or `skeleton` all separate the cache, matching `designKitPromptFragment`'s effect on the L2
 * prompt), and `enforceKitClasses` folds in **only when explicitly `false`** — the same non-default-only
 * pattern as `refConstraint` below, because both `true` and unset mean "the lint runs" and must stay
 * indistinguishable so a kit-less or already-linted cache key is untouched by this addition.
 * **A field folded in "only when non-default" must be written as an ABSENT key (`?? undefined`), never
 * as an explicit `null`**: `canonicalStringify`'s `sortDeep` (spec-core/canonical-json.ts) drops
 * `undefined` entries but keeps `null` ones, so a `null` default would still change the hashed bytes —
 * and therefore the cache key — for every policy that never touches that field. `refConstraint` below
 * folds to `null` in its default case only because that key has been part of this material's byte
 * layout since this function was introduced; a newly added key does not have that grandfathering and
 * must use `undefined` to stay truly additive.
 *
 * `refConstraint` participates **only when set to `"validate"`** — its default `"schema"` (whether set
 * explicitly or left unset) folds in as `null`, identically to being unset, so introducing this field
 * does not perturb the fingerprint (and therefore the cacheKey / any existing fixation-stability golden)
 * for every caller that has not opted into `"validate"`.
 *
 * `policy.effort` participates in full (both `l1`/`l2`, defaulted to `null` when only one is set)
 * whenever the object is set at all — effort changes generated output for the same Intent/model, so any
 * caller that wires it (even to `{}` with neither tier set — an edge case, but still a distinct policy
 * shape from never wiring the field) gets a separated cache key. Never set is indistinguishable from unset.
 *
 * The optional second argument `tierLlm` (compose.ts computes it via `tierLlmFingerprintMaterial(ctx)`
 * — see that function's own doc) folds in the identity of the models actually used per tier when
 * `ComposeContext.llmByTier` is wired to something that actually differs from the base `ctx.llm`. Passed
 * as `undefined` — its default — whenever `llmByTier` is unset or matches the base model everywhere, so a
 * caller that never touches `llmByTier` sees no change here either.
 *
 * **Which keys fold to `null` vs. an absent key, and why the material below looks inconsistent.** Ten of
 * the keys this function emits — `outputLanguage`, `designSystem` itself, `designSystem.tokens`,
 * `designSystem.guidelines`, `designSystem.enforceTokenColors`, `fewShotId`, `selectComponentsId`,
 * `refConstraint`, `effort`, `tierLlm` — fold to an explicit `null` in their default case. That is safe
 * *only* because all ten have been part of this material's hashed byte layout since the day each field
 * was added: every caller that has ever computed a fingerprint already has those `null` bytes baked into
 * its current cache key, so leaving them `null` changes nothing further. **It is not the pattern to copy**
 * — `fingerprintDesignSystem` below appears to write `?? null` ten times over, but that is historical
 * grandfathering, not a model for a new field. `designSystem.kit` / `designSystem.enforceKitClasses`
 * (Task 7b) show the correct shape for a field added *after* callers already depend on this material's
 * bytes: fold to `undefined` (an absent key), never `null` — see the ABSENT-key paragraph on their own
 * extractor below. **Any new fingerprinted field must follow `kit`/`enforceKitClasses`, not the other
 * ten** (`canonicalStringify`'s `sortDeep` drops `undefined` but keeps `null` — see spec-core/canonical-json.ts).
 */
type PolicyFingerprintExtractor = (
  policy: ComposePolicy,
  tierLlm: TierLlmFingerprintMaterial | undefined,
) => unknown;

function fingerprintOutputLanguage(policy: ComposePolicy): unknown {
  return policy.outputLanguage ?? null;
}

function fingerprintDesignSystem(policy: ComposePolicy): unknown {
  const { designSystem } = policy;
  if (designSystem == null) return null;
  return {
    tokens: designSystem.tokens ?? null,
    guidelines: designSystem.guidelines ?? null,
    enforceTokenColors: designSystem.enforceTokenColors ?? null,
    // Folded in only when non-default, and as an ABSENT key (undefined) rather than an
    // explicit null: canonicalStringify's sortDeep drops undefined entries but KEEPS null
    // ones (packages/spec-core/src/canonical-json.ts), so writing `?? null` here would add
    // "kit":null / "enforceKitClasses":null to the hashed bytes of every existing
    // designSystem-bearing policy that never touches either field, silently invalidating
    // its compose cache. `undefined` is the only value that reproduces the pre-existing
    // byte layout exactly. This is the shape a newly added key must use — see
    // policyFingerprint's own doc comment above for why the three keys above it get away
    // with `null` instead.
    //
    // `kit.classes` is folded in as-is below. Until Task 8/m-15, `designKitPromptFragment`
    // iterated `Object.entries(kit.classes)` in insertion order, so two vocabularies differing
    // only in that insertion order emitted different L2 prompt bytes even though
    // canonicalStringify's sortDeep (packages/spec-core/src/canonical-json.ts) sorts object
    // keys before hashing and so would otherwise hash two such vocabularies identically — hence
    // a `classesOrder` array (which sortDeep does not reorder) used to be carried here to force
    // the cache key to separate on that difference too. Task 8/m-15 made
    // `designKitPromptFragment` present classes **sorted by name** instead, so the prompt
    // itself is now a pure function of `kit.classes`' *content*, not its insertion order —
    // `classesOrder` no longer corresponds to anything the prompt bytes depend on, so it was
    // removed (its own regression test, "two kits differing only in the insertion order of
    // classes", now asserts the opposite: that reordering does NOT change the fingerprint).
    kit: designSystem.kit != null ? { ...designSystem.kit } : undefined,
    enforceKitClasses: designSystem.enforceKitClasses === false ? false : undefined,
  };
}

function fingerprintFewShotId(policy: ComposePolicy): unknown {
  const { fewShot } = policy;
  return fewShot != null ? (fewShot.id ?? "anonymous") : null;
}

function fingerprintSelectComponentsId(policy: ComposePolicy): unknown {
  const { selectComponents } = policy;
  return selectComponents != null ? (selectComponents.id ?? "anonymous") : null;
}

function fingerprintRefConstraint(policy: ComposePolicy): unknown {
  return policy.refConstraint === "validate" ? "validate" : null;
}

function fingerprintEffort(policy: ComposePolicy): unknown {
  const { effort } = policy;
  return effort != null ? { l1: effort.l1 ?? null, l2: effort.l2 ?? null } : null;
}

function fingerprintTierLlm(
  _policy: ComposePolicy,
  tierLlm: TierLlmFingerprintMaterial | undefined,
): unknown {
  return tierLlm ?? null;
}

/**
 * Ordered table of (material key, extractor) driving policyFingerprint() — mirrors Python's
 * `_FINGERPRINTED` (python/kohaku/src/kohaku/composer/context.py). One row per ComposePolicy field
 * that changes prompt content but was, until now, only enforced by the operational convention of
 * bumping `generatorVersion` by hand. Each extractor returns `null` when its field contributes
 * nothing (unset / default) — see `policyFingerprint`'s own doc comment above for which fields do
 * that via `?? null` (grandfathered into the byte layout) vs. via `?? undefined` (newly additive,
 * inside `fingerprintDesignSystem`'s returned object only) — and every row's key is always emitted
 * into `material`, including a `null` value, so the shape of the fingerprinted JSON is stable
 * regardless of which fields are set. Add a new row here (and a new extractor above) to fingerprint
 * another field; do not hand-sync a guard condition and an object literal separately.
 */
// Exported (but not re-exported from index.ts's public barrel) so the characterization test can
// assert the material key set directly — see the "detects an added/removed key" test in
// packages/composer/test/policy-fingerprint.test.ts, which fails if a key is added or removed here
// without the test being updated in the same change (the same purpose as Python's test reaching
// into `_FINGERPRINTED`).
export const FINGERPRINTED: ReadonlyArray<readonly [string, PolicyFingerprintExtractor]> = [
  ["outputLanguage", fingerprintOutputLanguage],
  ["designSystem", fingerprintDesignSystem],
  ["fewShotId", fingerprintFewShotId],
  ["selectComponentsId", fingerprintSelectComponentsId],
  ["refConstraint", fingerprintRefConstraint],
  ["effort", fingerprintEffort],
  ["tierLlm", fingerprintTierLlm],
];

export async function policyFingerprint(
  policy: ComposePolicy,
  tierLlm?: TierLlmFingerprintMaterial,
): Promise<string> {
  const material: Record<string, unknown> = {};
  for (const [key, extract] of FINGERPRINTED) {
    material[key] = extract(policy, tierLlm);
  }
  if (Object.values(material).every((value) => value == null)) {
    return "";
  }
  const hex = await sha256Hex(canonicalStringify(material));
  return hex.slice(0, 16);
}
