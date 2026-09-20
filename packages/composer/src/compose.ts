import { negotiate } from "@kohaku-ui/registry";
import {
  type CanonicalIntent,
  cacheKey,
  diffSpec,
  finalizeIntent,
  type JsonObject,
  type SemanticInput,
  type SessionContext,
  type SpecPatch,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { assembleSpec, cacheLabelOf, postAndValidate, shouldPersist } from "./assemble.js";
import { COMPOSER_ID } from "./constants.js";
import type { ComposeContext, ComposeErrorContext, ComposePolicy, FixedSpecSource } from "./context.js";
import { policyFingerprint, resolveEntryContext, tierLlmFingerprintMaterial } from "./context.js";
import { ComposeError } from "./errors.js";
import { buildFallbackSpec } from "./fallback.js";
import { fireObserverHook, reportComposeError } from "./observer.js";
import type { ResolvedRefs } from "./refs.js";
import { resolveRefs } from "./refs.js";
import { runGeneration } from "./single-flight.js";
import { runTierGeneration, type TierOutcome } from "./tier-ladder.js";
import { buildL1GenerationSchema } from "./tiers/l1-generate.js";
import type { ComposeAttempt, ComposeTrace, TraceBase, TraceContext } from "./trace.js";
import { buildComposeTrace } from "./trace.js";
import { traceIdentity } from "./trace-identity.js";

// COMPOSER_ID is defined in constants.js (a leaf module) and re-exported here so it stays resolvable
// from both "./index.js" and "./compose.js".
export { COMPOSER_ID } from "./constants.js";

export type ComposeInput =
  | SemanticInput
  | { kind: "intent"; intent: { canonical: string; params: JsonObject } };

export interface ComposeOptions {
  session?: SessionContext;
  /**
   * The caller's abort signal. Passes through to L1/L2 LLM generation (including the repair loop) as
   * req.abort. Aborts the full generation of a request abandoned by a client disconnect (host-rest passes
   * c.req.raw.signal) or a timeout. The exception thrown on abort rides the transient branch as ABORTED and
   * falls to the fallback immediately without a repair re-attempt (passing through to SemanticPort.normalize is out of scope).
   */
  abort?: AbortSignal;
  /**
   * A caller-supplied partial override applied on top of the resolved policy (after ctx.policy and, when
   * wired, ctx.policyFor's session policy have both been resolved). Exists so that a caller-level policy
   * decision (recompose's respectPrevTier routing to L2, for instance) is never silently discarded by
   * policyFor overwriting `policy` wholesale — see resolveEntryContext in context.ts, which applies this
   * last. Spread order there keeps the session policy's other fields (generatorVersion, etc.) while only
   * the overridden keys change.
   */
  policyOverride?: Partial<ComposePolicy>;
  /**
   * An optional caller-supplied correlation id, threaded unchanged into ComposeErrorContext.correlationId
   * (on every observer.onError call for this compose) and ComposeTrace.correlationId (the delivered
   * result's trace, hit/miss/fallback/follower alike), so a degraded or failed delivery can be tied back
   * to the request that triggered it. host-rest passes its per-request X-Request-Id / error.requestId;
   * host-mcp-apps passes the tool call's JSON-RPC request id. Purely additive and opt-in: omitting it
   * leaves both fields unset and does not otherwise affect compose behavior.
   */
  correlationId?: string;
  /**
   * An optional caller-supplied W3C trace context, threaded unchanged into ComposeErrorContext.traceContext
   * and ComposeTrace.traceContext (same additive/opt-in contract as correlationId above). host-rest reads
   * the `traceparent` request header; host-mcp-apps reads `_meta.traceparent` (MCP 2026-07-28 / SEP-414) --
   * both via host-core's shared parseTraceContext, which validates the W3C format before this is ever set.
   * Lets an OTel observer (see @kohaku-ui/otel's createOtelComposeObserver) record the compose span as a
   * child of the caller's own trace. Purely additive and opt-in: when omitted, behavior is unchanged.
   */
  traceContext?: TraceContext;
}

export interface ComposeResult {
  spec: UISpec;
  trace: ComposeTrace;
}

/**
 * The preparation result common to compose / composeStream.
 * Completes the normalized Intent, resolved references, cacheKey, and cache lookup, and passes them to the generation stage (runGeneration).
 * When cached is non-null it is a cache hit (no generation needed).
 */
export interface PreparedCompose {
  intent: CanonicalIntent;
  refs: ResolvedRefs;
  key: string;
  traceBase: TraceBase;
  cacheMode: "default" | "bypass";
  startedAt: number;
  policy: ComposePolicy;
  /** The caller's abort signal. generateSpec passes it through to the L1/L2 LLM calls. */
  abort?: AbortSignal;
  /** The Spec on a cache hit (with cache:"hit" applied) + the hit trace. null on miss/bypass. */
  cached: { spec: UISpec; trace: ComposeTrace } | null;
  /**
   * Memoized L0 fixed-Spec lookup (`policy.fixedSpecs?.lookup(intent)`, deterministic with respect to the
   * intent per FixedSpecSource's contract). composeStream's fast-path check and generateSpec's
   * tryFixedSpec both need exactly this lookup; sharing it here means the source is queried at most once
   * per compose regardless of how many call sites need the answer. Lazy: a cache hit never calls this, so
   * that path pays nothing extra for it.
   */
  getFixedSpec(): Promise<Awaited<ReturnType<FixedSpecSource["lookup"]>>>;
  /**
   * Memoized L1 generation-schema builder (`buildL1GenerationSchema(ctx, intent, refs)` — depends only on
   * values already fixed by the time prepareCompose returns). composeStream's provisional-patch decode
   * loop and generateL1's actual generation both need exactly this schema/includeTypes pair; sharing it
   * here means it is built at most once per compose. Lazy and synchronous (buildGenerationSchema does no
   * I/O): a cache hit / L0 short-circuit never calls this, so that path pays nothing extra for it.
   */
  getL1Schema(): ReturnType<typeof buildL1GenerationSchema>;
}

/**
 * Options threaded through the generation stage (runGeneration → generateSpec → runTierGeneration).
 * Distinct from ComposeOptions (which flows into prepareCompose): these only matter once generation
 * actually runs.
 */
export interface RunGenerationOptions {
  /**
   * The notification target for L1 generation progress (the LLM's cumulative partial draft) (incremental
   * streaming). Only composeStream passes it (via runGeneration's opts) = compose() (which passes no
   * opts) leaves the non-stream path completely unchanged in behavior. Under single-flight, **only the
   * leader's generation** notifies (followers get only the final form of the shared result).
   * The notified value is LlmPort.streamObject's cumulative partial as-is (unvalidated) — the consumer rebuilds from scratch each time.
   */
  onDraftPartial?: (raw: unknown) => void;
  /**
   * Dependency injection of the generation body (always compose.ts's generateSpec in practice). Threaded
   * in by the caller (compose() / composeStream()) rather than imported by single-flight.ts, so that
   * single-flight.ts (which compose.ts imports runGeneration from) has no value-level import back into
   * compose.ts — breaking what would otherwise be a compose.ts ⇄ single-flight.ts runtime import cycle.
   */
  generate: (
    prepared: PreparedCompose,
    ctx: ComposeContext,
    onDraftPartial?: (raw: unknown) => void,
  ) => Promise<GenerateOutcome>;
}

/** The result of the generation stage (L0/L1/L2/fallback). spec and its trace (the leader version or the follower version). */
export interface GenerateOutcome {
  spec: UISpec;
  trace: ComposeTrace;
}

/**
 * The sole entry point of the UI Composition Service (the implementation of the request sequence).
 * normalize → resolveQuery → cache lookup → L0/L1/L2 → deterministic post-processing → cache store.
 * Cross-surface identical display is structurally guaranteed by the cache key
 * (intentHash + dataVersion + catalogFingerprint). temperature 0 is merely an aid to reduce variance in the initial generation.
 */
export async function compose(
  input: ComposeInput,
  baseCtx: ComposeContext,
  opts: ComposeOptions = {},
): Promise<ComposeResult> {
  // Swap to the tenant's catalog and the session's policy just once (no transform if the hooks are
  // not wired). Must happen before prepareCompose — the cache key reads policy.generatorVersion.
  const ctx = resolveEntryContext(baseCtx, opts);
  try {
    const prepared = await prepareCompose(input, ctx, opts);
    // 4. Cache lookup (a path with zero LLM calls)
    if (prepared.cached != null) {
      return finish(prepared.cached.spec, prepared.cached.trace, ctx);
    }
    // 5-10. L0/L1/L2 generation + cache store (coalesced by single-flight).
    const { spec, trace } = await runGeneration(prepared, ctx, { generate: generateSpec });
    return finish(spec, trace, ctx);
  } catch (e) {
    // Notify the observation hook of a hard failure (a normalize / reference-resolution / final-validation exception) and re-throw.
    reportComposeError(
      ctx,
      {
        phase: "hard",
        input: toTraceInput(input),
        ...traceIdentity(opts),
      },
      e,
    );
    throw e;
  }
}

/**
 * The preparation stage through normalized Intent, reference resolution, cacheKey, and cache lookup.
 * Shared by compose and composeStream. Does not step into generation (L0/L1/L2) (fixedSpecs.lookup is done by runGeneration inside single-flight).
 */
export async function prepareCompose(
  input: ComposeInput,
  ctx: ComposeContext,
  opts: ComposeOptions = {},
): Promise<PreparedCompose> {
  const startedAt = Date.now();
  const policy = ctx.policy ?? {};

  // 1. Intent normalization (NL / GUI via SemanticPort; a structured Intent is just hash recomputation)
  let intent: CanonicalIntent;
  if (input.kind === "intent") {
    intent = await finalizeIntent(input.intent);
  } else {
    try {
      const normalized = await ctx.semantic.normalize(input, opts.session ?? { surface: "web" });
      intent = await finalizeIntent({ canonical: normalized.canonical, params: normalized.params });
    } catch (e) {
      throw new ComposeError("SEMANTIC_FAILED", "intent normalization failed", { cause: e });
    }
  }

  // 2. Deterministic query resolution (reference-passing handles) + dataVersion synthesis. tenant is used to resolve per-tenant promoted Intents.
  const refs = await resolveRefs(intent, ctx, opts.session?.tenant);

  // 3. Cache key (generatorVersion is added as the trailing component only when specified; policyFingerprint
  // is a derived 7th component — see context.ts's policyFingerprint doc — that is likewise omitted (empty
  // string) whenever the policy touches none of its fingerprinted fields, keeping the key unchanged).
  const pf = await policyFingerprint(policy, tierLlmFingerprintMaterial(ctx));
  const key = cacheKey({
    intentHash: intent.hash,
    dataVersion: refs.dataVersion,
    catalogFingerprint: ctx.catalog.fingerprint,
    ...(policy.generatorVersion != null ? { generatorVersion: policy.generatorVersion } : {}),
    ...(pf !== "" ? { policyFingerprint: pf } : {}),
  });

  const traceBase: TraceBase = {
    input: toTraceInput(input),
    intent,
    refs: refs.uris,
    dataVersion: refs.dataVersion,
    cacheKey: key,
    ...traceIdentity(opts),
  };

  // 4. Cache lookup (only when cacheMode==="default")
  const cacheMode = policy.cacheMode ?? "default";
  let cached: PreparedCompose["cached"] = null;
  if (cacheMode === "default") {
    const hit = await getSpecCacheSafely(ctx, policy, traceBase, intent, key);
    if (hit != null) {
      const spec: UISpec = { ...hit, provenance: { ...hit.provenance, cache: "hit" } };
      const trace = buildComposeTrace(
        { traceBase, startedAt },
        { cache: "hit", tier: hit.provenance.tier, attempts: [] },
      );
      cached = { spec, trace };
    }
  }

  // Lazily memoized so a cache hit / L0 short-circuit never pays for either: both are plain closures over
  // the already-resolved ctx/intent/refs/policy above, queried at most once no matter how many call sites
  // (composeStream's fast-path checks, generateSpec's tryFixedSpec, generateL1) need the answer.
  let fixedSpecCache: Promise<Awaited<ReturnType<FixedSpecSource["lookup"]>>> | undefined;
  const getFixedSpec = (): Promise<Awaited<ReturnType<FixedSpecSource["lookup"]>>> =>
    (fixedSpecCache ??= policy.fixedSpecs?.lookup(intent) ?? Promise.resolve(null));

  let l1SchemaCache: ReturnType<typeof buildL1GenerationSchema> | undefined;
  const getL1Schema = (): ReturnType<typeof buildL1GenerationSchema> =>
    (l1SchemaCache ??= buildL1GenerationSchema(ctx, intent, refs));

  return {
    intent,
    refs,
    key,
    traceBase,
    cacheMode,
    startedAt,
    policy,
    ...(opts.abort != null ? { abort: opts.abort } : {}),
    cached,
    getFixedSpec,
    getL1Schema,
  };
}

/**
 * Shared fail-open template for the Spec cache: runs fn(), and on a thrown error reports it to
 * observer.onError (phase "cache") and returns fallback instead of propagating, so a cache-backend
 * outage does not turn every compose into a hard failure after a successful generation (or lookup).
 * policy.cacheFailure === "closed" opts back into rethrowing the original error instead. Shared by
 * getSpecCacheSafely (fallback null) and putSpecCacheSafely (fallback undefined).
 */
async function withCacheFailOpen<T>(
  ctx: ComposeContext,
  policy: ComposePolicy,
  errCtx: Omit<ComposeErrorContext, "phase">,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    reportComposeError(ctx, { phase: "cache", ...errCtx }, e);
    if (policy.cacheFailure === "closed") throw e;
    return fallback;
  }
}

/** Fail-open ctx.storage.getSpecCache (treats a failure as a cache miss); see withCacheFailOpen. */
async function getSpecCacheSafely(
  ctx: ComposeContext,
  policy: ComposePolicy,
  traceBase: Pick<TraceBase, "input" | "correlationId" | "traceContext">,
  intent: CanonicalIntent,
  key: string,
): Promise<UISpec | null> {
  return withCacheFailOpen(
    ctx,
    policy,
    { input: traceBase.input, intent, cacheKey: key, ...traceIdentity(traceBase) },
    () => ctx.storage.getSpecCache(key),
    null,
  );
}

/** Fail-open ctx.storage.putSpecCache (the Spec is still delivered on failure); see withCacheFailOpen. */
async function putSpecCacheSafely(
  ctx: ComposeContext,
  prepared: PreparedCompose,
  spec: UISpec,
): Promise<void> {
  await withCacheFailOpen(
    ctx,
    prepared.policy,
    {
      input: prepared.traceBase.input,
      intent: prepared.intent,
      cacheKey: prepared.key,
      ...traceIdentity(prepared.traceBase),
    },
    () => ctx.storage.putSpecCache(prepared.key, spec, prepared.policy.ttlSeconds),
    undefined,
  );
}

/**
 * The body of L0/L1/L2 generation + cache store. One call = the leader's generation (runs inside the
 * single-flight leader/follower logic). The return value is the spec and its leader trace.
 */
export async function generateSpec(
  prepared: PreparedCompose,
  ctx: ComposeContext,
  onDraftPartial?: (raw: unknown) => void,
): Promise<GenerateOutcome> {
  // 5. L0: fixed Spec (the promoted high-frequency, high-confidence path)
  const fixed = await tryFixedSpec(prepared, ctx);
  if (fixed != null) return fixed;

  // 6-7. L1 constrained generation → L2 free generation → deterministic fallback (the branching is consolidated in runTierGeneration).
  const attempts: ComposeAttempt[] = [];
  const outcome = await runTierGeneration(prepared, ctx, attempts, onDraftPartial);
  const spec = buildSpecFromOutcome(prepared, ctx, outcome);
  // 9-10. Cache store + leader trace assembly.
  return persistAndTrace(prepared, ctx, spec, outcome, attempts);
}

/**
 * The L0 fixed-Spec short-circuit. If lookup hits, runs all the way through assemble → post-processing →
 * cache store → trace, and on a miss returns null (the caller proceeds to the L1/L2 ladder).
 */
async function tryFixedSpec(prepared: PreparedCompose, ctx: ComposeContext): Promise<GenerateOutcome | null> {
  const { intent, refs, cacheMode } = prepared;
  // Shared with composeStream's fast-path check via PreparedCompose.getFixedSpec (memoized) — see its doc.
  const fixed = await prepared.getFixedSpec();
  if (fixed == null) return null;

  const cacheLabel = cacheLabelOf(cacheMode);
  const template = typeof fixed === "function" ? fixed(intent, refs.handles) : fixed;
  const assembled = assembleSpec({
    intent,
    refs,
    components: template.components,
    events: template.events,
    tier: "L0",
    cache: cacheLabel,
    // Carry the fixed template's state over to the delivered Spec (preserve visibleWhen's initial state).
    ...(template.state != null ? { state: template.state } : {}),
  });
  const l0spec = postAndValidate(assembled, refs, ctx);
  if (shouldPersist(l0spec, cacheMode)) {
    await putSpecCacheSafely(ctx, prepared, l0spec);
  }
  const trace = buildComposeTrace(prepared, { cache: cacheLabel, tier: "L0", attempts: [] });
  return { spec: l0spec, trace };
}

/**
 * Builds the delivered Spec from a TierOutcome. If ok, assemble + post-processing; if fallback, returns
 * the deterministic fallback Spec and fires the observation hook exactly once (the once-per-generation contract is fixed here).
 */
function buildSpecFromOutcome(prepared: PreparedCompose, ctx: ComposeContext, outcome: TierOutcome): UISpec {
  const { intent, refs, key, cacheMode, traceBase } = prepared;
  const cacheLabel = cacheLabelOf(cacheMode);

  if (outcome.kind === "ok") {
    const assembled = assembleSpec({
      intent,
      refs,
      components: outcome.components,
      events: outcome.events,
      tier: outcome.tier,
      cache: cacheLabel,
      ...(outcome.model != null ? { model: outcome.model } : {}),
    });
    return postAndValidate(assembled, refs, ctx);
  }

  const spec = buildFallbackSpec({
    intent,
    dataVersion: refs.dataVersion,
    reason: outcome.reason,
    composedBy: COMPOSER_ID,
    cache: cacheLabel,
    from: outcome.from, // Reflect the tier that actually failed in provenance.tier / fallback.from
  });
  // Make the deterministic downgrade on generation failure observable. Once per generation (only the
  // single-flight leader passes through). tier is "the stage that actually failed". from becomes L2
  // on an L2 failure via route=L2 direct entry or an L1→L2 promotion.
  // budgetExceeded is true only for a budget-guard downgrade (for machine discrimination without relying on reason string-matching).
  // phase is "cancelled" rather than "fallback" when the fallback was caused by the caller's abort
  // (client disconnect/timeout), so hosts can skip counting it against the generation-fallback rate.
  reportComposeError(
    ctx,
    {
      phase: outcome.cancelled === true ? "cancelled" : "fallback",
      input: traceBase.input,
      intent,
      cacheKey: key,
      tier: outcome.from,
      reason: outcome.reason,
      ...(outcome.budgetExceeded ? { budgetExceeded: true } : {}),
      ...traceIdentity(traceBase),
    },
    undefined,
  );
  return spec;
}

/**
 * After the cache store (the condition/timing is consolidated in shouldPersist), builds the ComposeTrace
 * for the leader. Because the L0 short-circuit does the equivalent store/trace on the tryFixedSpec side, this is dedicated to the L1/L2/fallback path.
 */
async function persistAndTrace(
  prepared: PreparedCompose,
  ctx: ComposeContext,
  spec: UISpec,
  outcome: TierOutcome,
  attempts: ComposeAttempt[],
): Promise<GenerateOutcome> {
  const { cacheMode } = prepared;
  const cacheLabel = cacheLabelOf(cacheMode);

  // 9-10. Cache store (the L0/L1/L2-common decision is consolidated in shouldPersist).
  if (shouldPersist(spec, cacheMode)) {
    await putSpecCacheSafely(ctx, prepared, spec);
  }

  const usage = sumUsage(attempts);
  const trace = buildComposeTrace(prepared, {
    cache: cacheLabel,
    tier: spec.provenance.tier,
    attempts,
    ...(outcome.kind === "fallback" ? { fallback: { reason: outcome.reason } } : {}),
    ...(outcome.kind === "fallback" && outcome.cancelled === true ? { cancelled: true } : {}),
    ...(outcome.kind === "ok" && outcome.model != null ? { model: outcome.model } : {}),
    ...(usage != null ? { usage } : {}),
  });
  return { spec, trace };
}

/**
 * Surface capability negotiation (negotiate). Applied every time outside the cache (deterministic).
 * No transform if ctx.surface is unspecified. Passing trace reflects downgrade traces in trace.downgrades.
 */
export function negotiateSpec(spec: UISpec, ctx: ComposeContext, trace?: ComposeTrace): UISpec {
  if (ctx.surface == null) return spec;
  const negotiated = negotiate(spec, ctx.catalog, ctx.surface);
  if (trace != null && negotiated.downgrades.length > 0) trace.downgrades = negotiated.downgrades;
  return negotiated.spec;
}

/** negotiate application + observer notification → ComposeResult. Called exactly once for the final Spec. */
export function finish(spec: UISpec, trace: ComposeTrace, ctx: ComposeContext): ComposeResult {
  const result = negotiateSpec(spec, ctx, trace);
  const hook = ctx.observer?.onComposed;
  if (hook != null) fireObserverHook(() => hook(trace, result));
  return { spec: result, trace };
}

/** Normalizes ComposeInput into the form placed on trace/observer (drops the intent body, keeps only kind). */
export function toTraceInput(input: ComposeInput): SemanticInput | { kind: "intent" } {
  return input.kind === "intent" ? { kind: "intent" } : input;
}

/** Sums the attempts' usage. undefined if not a single attempt has usage. */
function sumUsage(attempts: ComposeAttempt[]): { inputTokens: number; outputTokens: number } | undefined {
  let has = false;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const a of attempts) {
    if (a.usage == null) continue;
    has = true;
    inputTokens += a.usage.inputTokens;
    outputTokens += a.usage.outputTokens;
  }
  return has ? { inputTokens, outputTokens } : undefined;
}

/** Interaction loop: Intent diff → Spec differential update */
export async function recompose(
  prev: UISpec,
  patch: { canonical?: string; params: JsonObject },
  ctx: ComposeContext,
  opts: ComposeOptions & {
    /**
     * When true and the previous Spec is L2 (free generation), fix the differential update to the L2 path too.
     * Prevents a screen established at L2 from dropping to L1 on every params change and being swapped for a different UI.
     * Default false (follows ctx.policy.routeTier / defaults to L1).
     */
    respectPrevTier?: boolean;
  } = {},
): Promise<{ result: ComposeResult; patch: SpecPatch }> {
  const intent = {
    canonical: patch.canonical ?? prev.intent.canonical,
    params: { ...prev.intent.params, ...patch.params },
  };
  // The L2 pin is passed as a policyOverride rather than folded into ctx up front, so that it survives
  // resolveEntryContext's withSessionPolicy step even when ctx.policyFor is wired (a session policy
  // resolved from scratch would otherwise silently discard this override — see resolveEntryContext).
  const composeOpts =
    opts.respectPrevTier === true && prev.provenance.tier === "L2"
      ? { ...opts, policyOverride: { ...opts.policyOverride, routeTier: () => "L2" as const, allowL2: true } }
      : opts;
  const result = await compose({ kind: "intent", intent }, ctx, composeOpts);
  return { result, patch: diffSpec(prev, result.spec) };
}
