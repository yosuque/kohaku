import type { GenerationSchema, ValidateAgainstCatalogResult } from "@kohaku-ui/registry";
import {
  type CanonicalIntent,
  type ComponentNode,
  diffSpec,
  type SpecPatch,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { assembleSpec, postAndValidate } from "./assemble.js";
import {
  type ComposeInput,
  type ComposeOptions,
  type ComposeResult,
  finish,
  generateSpec,
  negotiateSpec,
  type PreparedCompose,
  prepareCompose,
  toTraceInput,
} from "./compose.js";
import type { ComposeContext, ResolvedRefs } from "./context.js";
import { resolveEntryContext, resolveTierLlm } from "./context.js";
import { reportComposeError } from "./observer.js";
import { runGeneration } from "./single-flight.js";

/**
 * The minimum wall-clock interval, in milliseconds, between two provisional-patch emissions during
 * streaming. A fast streamObject producer (frequent token-level deltas) would otherwise pay the full
 * build+diff cost (decode, per-component catalog re-validate, structural post-processing, a full
 * canonicalStringify diff) on every single partial; this caps that to at most once per interval. The very
 * next partial after the wait always reflects the freshest draft (the existing "keep only latest"
 * coalescing below is unaffected), and the final patch (after generation completes) is never delayed by
 * this — see the while loop below.
 */
const PROVISIONAL_PATCH_THROTTLE_MS = 60;

/**
 * composeStream's events.
 * - `spec`: the initial Spec (with negotiate applied). final=true completes in one event (cache hit / L0 /
 *   fixation short-circuit); final=false is the skeleton (patches follow after this). refs is all resolved
 *   QueryHandle URIs (for the host's capability issuance).
 * - `patch`: diffs (0..N times). **provisional patches** during generation (diffs to a provisional Spec
 *   built from the LLM's partial output) continue 0 or more times, converging at the end with a patch to
 *   the final form. spec is the form with the patch already applied (removes the need for the host to
 *   re-apply). The result of applyPatch in reception order is always a structurally validated Spec (REST-STR-002).
 * - `done`: the terminal. result is the same ComposeResult as a non-stream compose.
 */
export type ComposeStreamInternalEvent =
  | { kind: "spec"; spec: UISpec; final: boolean; refs: string[] }
  | { kind: "patch"; patch: SpecPatch; spec: UISpec }
  | { kind: "done"; result: ComposeResult };

/**
 * The streaming version of compose (spec/SPEC.md §6.1.1 [Draft]).
 * The slow path (L1/L2) returns a skeleton (ui.loading) immediately, returns **patches to a provisional
 * Spec** built from the LLM's partial output incrementally during generation (only when LlmPort.streamObject
 * is implemented; 0..N times), and converges after generation completes with a patch to the final form. The
 * fast path (cache hit / L0 / fixation short-circuit) does not emit a skeleton and completes in one event with final:true.
 *
 * The generation body, single-flight, and cache store are identical to compose() (sharing runGeneration).
 * The skeleton and provisional Specs are never made cache / lineage records / fixation candidates (only the
 * generation body does putSpecCache. The MUST NOT of spec/SPEC.md §6.1.1). single-flight followers do not
 * receive provisional patches (only the final form of the shared result). observer.onComposed is called exactly once for the final Spec (inside finish).
 *
 * Errors are thrown (same as compose; no error variant is made on the iterable). An L1/L2 failure after
 * skeleton emission does not reach here because buildFallbackSpec returns a normal-path Spec, arriving as "a patch to the fallback Spec".
 */
export async function* composeStream(
  input: ComposeInput,
  baseCtx: ComposeContext,
  opts: ComposeOptions = {},
): AsyncGenerator<ComposeStreamInternalEvent, void> {
  // Like compose(), swap to the tenant's catalog and the session's policy just once
  // (no transform if the hooks are not wired; before prepareCompose for cache-key correctness).
  const ctx = resolveEntryContext(baseCtx, opts);
  try {
    const prepared = await prepareCompose(input, ctx, opts);
    const refs = prepared.refs.uris;

    // 1. Cache hit: complete in one event with final:true, the Spec with negotiate applied.
    if (prepared.cached != null) {
      const result = finish(prepared.cached.spec, prepared.cached.trace, ctx);
      yield { kind: "spec", spec: result.spec, final: true, refs };
      yield { kind: "done", result };
      return;
    }

    // 2. An L0 fixed-Spec match also completes in one event with final:true after generation (no skeleton
    //    emitted). Since fixedSpecs.lookup is deterministic with respect to the intent, the re-lookup inside
    //    runGeneration produces a matching result (even if it becomes a follower, the shared result for the same intent is L0).
    //    getFixedSpec is memoized on PreparedCompose (see its doc), so this and generateSpec's tryFixedSpec
    //    (invoked by runGeneration just below) query the FixedSpecSource at most once between them.
    const fixed = await prepared.getFixedSpec();
    if (fixed != null) {
      const { spec, trace } = await runGeneration(prepared, ctx, { generate: generateSpec });
      const result = finish(spec, trace, ctx);
      yield { kind: "spec", spec: result.spec, final: true, refs };
      yield { kind: "done", result };
      return;
    }

    // 3. L1/L2 path: return the skeleton (root + ui.loading) immediately. dataVersion / refVersions are
    //    resolved values, so they are identical to the final form → the diff becomes small.
    const skeleton = negotiateSpec(buildSkeletonSpec(prepared.intent, prepared.refs, ctx), ctx);
    yield { kind: "spec", spec: skeleton, final: false, refs };

    // 4. Deliver the partial output during generation (LlmPort.streamObject) incrementally as provisional
    //    patches. Conflating (keep only the latest partial): when consumption cannot keep up with
    //    generation, skip intermediate forms. When streamObject is not implemented / on the prompt-JSON
    //    fallback, no partial arrives and it is only "skeleton → final patch".
    let latestPartial: unknown;
    let hasPartial = false;
    let generationDone = false;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      wake?.();
      wake = null;
    };
    // Streaming is L1-only (see generateL1's onDraftPartial contract), so the capability check must read
    // the tier's actually-resolved port (ComposeContext.llmByTier) rather than the base ctx.llm — otherwise
    // a compose with llmByTier.L1 set to a streamObject-capable port while the base llm is not (or vice
    // versa) would decide the fast-path wrong here even though generateL1 itself resolves correctly.
    const onDraftPartial =
      resolveTierLlm(ctx, "L1").streamObject != null
        ? (raw: unknown): void => {
            latestPartial = raw;
            hasPartial = true;
            notify();
          }
        : undefined;

    // Run generation (single-flight) in parallel without awaiting, receiving only the completion notification (the result/exception is handled by the later await).
    const genPromise = runGeneration(prepared, ctx, { onDraftPartial, generate: generateSpec });
    void genPromise.then(
      () => {
        generationDone = true;
        notify();
      },
      () => {
        generationDone = true;
        notify();
      },
    );

    // The decode used to assemble a provisional Spec (same configuration as the generation schema).
    // getL1Schema is memoized on PreparedCompose (see its doc): building it here means generateL1's own
    // generation call (invoked by runGeneration above) reuses the exact same schema/includeTypes pair
    // instead of building it a second time — and, symmetrically with the previous behavior, calling it for
    // the first time only when a partial actually arrives still spares the streamObject-unimplemented /
    // no-partial path the schema-construction cost.
    let generation: GenerationSchema | null = null;
    let lastSpec = skeleton;
    // Wall-clock timestamp of the last provisional-patch emission (null before the first one) — the basis
    // for PROVISIONAL_PATCH_THROTTLE_MS below.
    let lastEmitAt: number | null = null;
    while (!generationDone) {
      if (!hasPartial) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      // Throttle: do not process (and thus do not diff/emit) a pending partial until at least
      // PROVISIONAL_PATCH_THROTTLE_MS have passed since the last emission. A newer partial that arrives
      // during the wait keeps overwriting latestPartial (the "keep only latest" coalescing already in
      // effect above), so the emission right after the wait always reflects the freshest draft. The wait
      // itself is interruptible (a fresh notify() — a new partial or generation completing — resolves it
      // immediately so it is re-evaluated against the now-current state rather than sleeping needlessly).
      if (lastEmitAt != null) {
        const remaining = PROVISIONAL_PATCH_THROTTLE_MS - (Date.now() - lastEmitAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, remaining);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          continue;
        }
      }
      const raw = latestPartial;
      hasPartial = false;
      generation ??= prepared.getL1Schema().generation;
      const provisional = buildProvisionalSpec(raw, prepared, ctx, generation);
      if (provisional == null) continue;
      const patch = diffSpec(lastSpec, provisional);
      if (isEmptyPatch(patch)) continue;
      yield { kind: "patch", patch, spec: provisional };
      lastSpec = provisional;
      lastEmitAt = Date.now();
    }

    // 5. Final: patch to the final Spec → done (a diff from the provisional form).
    const { spec, trace } = await genPromise;
    const result = finish(spec, trace, ctx);
    const patch = diffSpec(lastSpec, result.spec);
    yield { kind: "patch", patch, spec: result.spec };
    yield { kind: "done", result };
  } catch (e) {
    // Notify the observation hook of a hard failure (whether before or after skeleton emission) and re-throw.
    // An L1/L2 failure after skeleton emission does not reach here because buildFallbackSpec returns a normal-path Spec.
    reportComposeError(
      ctx,
      {
        phase: "hard",
        input: toTraceInput(input),
        ...(opts.correlationId != null ? { correlationId: opts.correlationId } : {}),
        ...(opts.traceContext != null ? { traceContext: opts.traceContext } : {}),
      },
      e,
    );
    throw e;
  }
}

/**
 * Deterministically constructs the skeleton Spec for the streaming initial display.
 * Two nodes: root (layout.stack) + ui.loading. Routing it through postAndValidate aligns the
 * component-version filling and props-default filling (such as ui.loading's label) with the generated Spec.
 * The skeleton is not made a cache / lineage record / fixation target (does not go through putSpecCache).
 */
function buildSkeletonSpec(intent: CanonicalIntent, refs: ResolvedRefs, ctx: ComposeContext): UISpec {
  const raw = assembleSpec({
    intent,
    refs,
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: "md" },
        children: ["loading1"],
      },
      { id: "loading1", type: "ui.loading", props: {} },
    ],
    events: [],
    tier: "L1",
    cache: "miss",
  });
  return postAndValidate(raw, refs, ctx);
}

/**
 * Builds a provisional Spec from the LLM's cumulative partial draft (parse & heal). null (skip) at stages where it cannot be built.
 *
 * Breakdown of heal:
 * - Incomplete forms where decode (the generation schema's defensive transform) throws are skipped (wait for the next partial).
 * - Validate against the catalog per component, keeping **only completed components** (the trailing component mid-generation naturally drops).
 * - `children` are pruned to already-arrived ids (an un-arrived reference would fail structural validation).
 * - `events` are not put on the provisional form (payload-template reference integrity is not guaranteed on the intermediate form; they arrive on the final patch).
 * - Finally route through the usual deterministic post-processing + structural validation (postAndValidate), skipping at stages that do not pass.
 *   ID applies normalizeIds (root held in place + DFS-order sequence numbers) incrementally — for
 *   append-centric partial output, prefix sequence numbers are practically stable, and even if they waver
 *   the final patch converges to the canonical form (REST-STR-002 is guaranteed by construction).
 *
 * A provisional Spec is out of scope for cache / recording / fixation (the caller merely streams it as an event).
 */
export function buildProvisionalSpec(
  raw: unknown,
  prepared: PreparedCompose,
  ctx: ComposeContext,
  generation: GenerationSchema,
): UISpec | null {
  let components: ComponentNode[];
  try {
    components = generation.decode(raw).components;
  } catch {
    return null; // An incomplete partial (components not yet an array, etc.) — wait for the next
  }

  // Validate the whole batch in one call rather than once per component: validateAgainstCatalog has no
  // cross-component dependency here (a provisional Spec never carries events, the one place validate()
  // looks across components), so a single full-array call yields exactly the same per-component verdicts
  // as calling it once per component, at a fraction of the cost for a partial with many components.
  // Reusing its `normalized` output (catalog defaults already filled) also spares postAndValidate's
  // canonicalProps rule from re-deriving the identical normalization a second time below — re-running
  // catalog.validate on already-normalized props is idempotent, so the final bytes are unchanged.
  let validated: ValidateAgainstCatalogResult;
  try {
    validated = ctx.catalog.validate(components, []);
  } catch {
    return null;
  }
  const invalidIds = new Set(validated.issues.map((i) => i.componentId));
  // Keep only completed components (an unknown type or a missing required prop drops here).
  const complete = validated.normalized.filter((c) => !invalidIds.has(c.id));
  if (complete.length === 0) return null;

  // Prune children to already-arrived ids (an un-arrived forward reference is structural-validation NG, so hide it on the provisional form).
  const ids = new Set(complete.map((c) => c.id));
  // Without a root component, assembleSpec/postAndValidate would throw (SpecError wrapped as ComposeError)
  // purely to be caught by the try/catch below and turned back into null. Check for it directly instead —
  // an exception thrown-and-immediately-discarded on every partial lacking root is pure waste on the
  // streaming hot path (this fires on every early partial before root has fully arrived).
  if (!ids.has("root")) return null;
  const pruned = complete.map((c) =>
    c.children != null ? { ...c, children: c.children.filter((id) => ids.has(id)) } : c,
  );
  // Do not emit a provisional at the stage where only root is completed (so as not to create a moment that
  // "looks like it disappeared" by replacing the skeleton's ui.loading with an empty container. Swap only once one real component is present).
  if (!pruned.some((c) => c.id !== "root")) return null;

  const rawSpec = assembleSpec({
    intent: prepared.intent,
    refs: prepared.refs,
    components: pruned,
    events: [],
    tier: "L1",
    cache: "miss",
  });
  try {
    // Route through the same deterministic post-processing + validation + negotiate as the skeleton/final
    // form (guaranteeing that the Spec after applyPatch is always valid). Skip with null at stages that do not pass, such as root not yet arrived.
    return negotiateSpec(postAndValidate(rawSpec, prepared.refs, ctx), ctx);
  } catch {
    return null;
  }
}

/** Whether diffSpec's result is "no diff" (baseIntentHash only). */
function isEmptyPatch(patch: SpecPatch): boolean {
  return (
    patch.intent == null &&
    patch.upsert == null &&
    patch.remove == null &&
    patch.events == null &&
    patch.dataVersion == null &&
    patch.refVersions === undefined &&
    patch.state === undefined &&
    patch.provenance == null
  );
}
