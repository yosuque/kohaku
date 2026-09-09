import type { StoragePort } from "@kohaku-ui/spec-core";
import { cacheLabelOf } from "./assemble.js";
import type { GenerateOutcome, PreparedCompose, RunGenerationOptions } from "./compose.js";
import type { ComposeContext } from "./context.js";
import { buildComposeTrace } from "./trace.js";

/**
 * The in-flight compose table per storage (for single-flight / coalescing). Process-local.
 * Folds concurrent composes of the same key into one generation, and followers ride along on the result
 * of the leading compose. Generation runs on the shared AbortController's signal rather than the leader's
 * own AbortSignal, and generation is aborted **only when all waiters have aborted** — so that the leader's
 * client disconnect does not propagate to a healthy follower as a fallback (error screen) (make the blast
 * radius of a cancel a voting matter). Coalescing in a distributed environment will be handled by a future
 * StoragePort extension (shared lock).
 */
interface InflightEntry {
  promise: Promise<GenerateOutcome>;
  controller: AbortController;
  waiters: number;
}

const inflightByStorage = new WeakMap<StoragePort, Map<string, InflightEntry>>();

function inflightMap(storage: StoragePort): Map<string, InflightEntry> {
  let map = inflightByStorage.get(storage);
  if (map == null) {
    map = new Map();
    inflightByStorage.set(storage, map);
  }
  return map;
}

/**
 * Joins an in-flight entry as a waiter. When the caller's signal is aborted, decrements the waiter count,
 * and once it reaches 0, aborts the shared generation (stop generation only when the last one leaves).
 * The return value is a release function to call when waiting ends (returns the count exactly once whether it finished normally or was aborted).
 */
function joinInflight(entry: InflightEntry, signal: AbortSignal | undefined): () => void {
  entry.waiters += 1;
  let released = false;
  const onAbort = (): void => {
    if (released) return;
    released = true;
    entry.waiters -= 1;
    if (entry.waiters === 0) entry.controller.abort();
  };
  const release = (): void => {
    if (released) return;
    released = true;
    entry.waiters -= 1;
    signal?.removeEventListener("abort", onAbort);
  };
  if (signal != null) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return release;
}

/**
 * Runs generation under single-flight. When cacheMode==="default", folds concurrent generations of the
 * same key into one. bypass respects the intent of forced regeneration and does not coalesce (always runs
 * as the leader equivalent). Called from both compose and composeStream, and a concurrent compose during a stream also merges via the final Spec cache.
 */
export async function runGeneration(
  prepared: PreparedCompose,
  ctx: ComposeContext,
  opts: RunGenerationOptions,
): Promise<GenerateOutcome> {
  const { key, cacheMode } = prepared;
  if (cacheMode !== "default") {
    return opts.generate(prepared, ctx, opts.onDraftPartial);
  }

  const table = inflightMap(ctx.storage);
  const existing = table.get(key);
  if (existing != null) {
    // Follower: ride along on the result of the leading compose (the leader's throw also propagates here).
    // Its own signal is used only as a "vote to abort the shared generation" (generation stops only when everyone aborts).
    const release = joinInflight(existing, prepared.abort);
    try {
      const shared = await existing.promise;
      return buildFollowerOutcome(shared, prepared);
    } finally {
      release();
    }
  }

  // Leader: register the generation Promise first, then run it, and always remove it from the table in
  // finally. By making the registered Promise and the awaited Promise identical, even if the leader throws
  // (and there is no follower), it does not become an unhandled rejection.
  // Pass the shared controller's signal to generation rather than the leader's own signal — so that the
  // leader's client disconnect does not propagate to a healthy follower as a fallback. If the leader is the
  // only waiter, an abort reaches generation immediately (joinInflight aborts at once with count 0).
  const controller = new AbortController();
  // Optional abort signal compatibility: when the caller did not pass abort, req.abort also stays undefined
  // (in this case the leader waits until completion, so the waiter count does not reach 0 and the controller is effectively unused).
  const entry: InflightEntry = {
    promise: opts.generate(
      prepared.abort != null ? { ...prepared, abort: controller.signal } : prepared,
      ctx,
      opts.onDraftPartial,
    ),
    controller,
    waiters: 0,
  };
  table.set(key, entry);
  // As soon as the last waiter leaves and the shared controller aborts, remove the entry immediately
  // rather than waiting for entry.promise to settle. Without this, a new caller arriving in the window
  // between the abort firing and the (now-doomed, about-to-fall-back) promise resolving would be
  // coalesced onto that cancelled result instead of becoming a fresh leader.
  controller.signal.addEventListener(
    "abort",
    () => {
      if (table.get(key) === entry) table.delete(key);
    },
    { once: true },
  );
  const release = joinInflight(entry, prepared.abort);
  try {
    return await entry.promise;
  } finally {
    release();
    // Delete only when it is the entry this call registered (do not erase a table a subsequent leader replaced).
    if (table.get(key) === entry) table.delete(key);
  }
}

/** Finishes the follower's (coalescing) Spec/trace. A fallback keeps the leader's label rather than pretending to be a hit. */
function buildFollowerOutcome(shared: GenerateOutcome, prepared: PreparedCompose): GenerateOutcome {
  const sharedSpec = shared.spec;
  const isFallback = sharedSpec.provenance.fallback != null;
  const spec = isFallback
    ? sharedSpec
    : { ...sharedSpec, provenance: { ...sharedSpec.provenance, cache: "hit" as const } };
  const trace = buildComposeTrace(prepared, {
    // Riding along on a normal generation is a hit (synonymous with a cache hit). A fallback keeps the leader's label.
    cache: isFallback ? cacheLabelOf(prepared.cacheMode) : "hit",
    tier: sharedSpec.provenance.tier,
    attempts: [],
    coalesced: true,
    ...(isFallback && sharedSpec.provenance.fallback != null
      ? { fallback: { reason: sharedSpec.provenance.fallback.reason } }
      : {}),
    ...(sharedSpec.provenance.model != null ? { model: sharedSpec.provenance.model } : {}),
    // Propagate cancellation from the leader's trace so followers are equally excluded from lineage
    // recording and the fallback-rate analytics when the leader's generation was aborted.
    ...(shared.trace.cancelled === true ? { cancelled: true } : {}),
  });
  return { spec, trace };
}
