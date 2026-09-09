import { parseQueryRef } from "@kohaku-ui/data-binding";
import { notifyHook, parseInvokableRef } from "@kohaku-ui/host-core";
import { enumerateBindVariants, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import type { ToolContext } from "./types.js";

/**
 * Cumulative size budget (in JSON characters) for the initial data co-embedded in a tool result's `_meta`.
 * On Claude-family hosts, once a tool result exceeds about 150,000 characters it is offloaded to the sandbox side and
 * the widget does not hydrate, so we cut off at 100,000 characters, leaving room for the structured Spec plus the text
 * fallback. Anything over budget is not embedded (partial embedding). Each component's initial variant ($ref) is filled
 * first, with priority.
 */
const INITIAL_DATA_BUDGET_CHARS = 100_000;

/**
 * Per-ref timeout (ms) for initial-data preresolution. This cap is applied to each ref's resolution, and
 * an overrun is treated the same as the existing per-ref fail-open (exception -> skip and continue; reported to
 * the observation hook if present). Also used by snapshot.ts's snapshotHtmlFor (same per-ref primitive, full
 * resolution rather than a budgeted embed).
 */
const PRERESOLVE_TIMEOUT_MS = 2000;

/**
 * Overall wall-clock deadline (ms; ops) for the whole preresolveInitialData call, on top of the per-ref timeout
 * above. Refs are resolved with bounded concurrency (see PRERESOLVE_CONCURRENCY), so a single hung dependency no
 * longer blocks the others, but with up to 256 bind variants across many components, even a healthy but slow
 * DomainPort can still push total latency well past what a tool caller will wait for. Once this deadline
 * elapses, no further refs are started and any still-in-flight resolution's eventual result (success or
 * failure) is discarded rather than embedded — reported via the same per-ref fail-open onError path as a
 * regular per-ref failure, with a message identifying it as a deadline discard rather than a resolution error.
 */
const PRERESOLVE_TOTAL_TIMEOUT_MS = 10_000;

/** Bounded concurrency (ops) for preresolveInitialData's ref resolution pool. See PRERESOLVE_TOTAL_TIMEOUT_MS. */
const PRERESOLVE_CONCURRENCY = 8;

/**
 * Test-only per-ref timeout override (the public API = index.ts's exports are unchanged). null means the default.
 * For deterministic timeout verification (that a tool response returns even when a ref never returns), tests import
 * this function via server.ts's re-export from `../src/server.js` and inject a short value.
 */
let preresolveTimeoutMsOverride: number | null = null;
export function __setPreresolveTimeoutMsForTest(ms: number | null): void {
  preresolveTimeoutMsOverride = ms;
}

/** The current per-ref preresolution timeout, honoring the test override. Shared with snapshot.ts. */
export function preresolveTimeoutMs(): number {
  return preresolveTimeoutMsOverride ?? PRERESOLVE_TIMEOUT_MS;
}

/** Test-only override of the overall preresolveInitialData deadline (ops). null means the default. */
let preresolveTotalTimeoutMsOverride: number | null = null;
export function __setPreresolveTotalTimeoutMsForTest(ms: number | null): void {
  preresolveTotalTimeoutMsOverride = ms;
}

/** The current overall preresolveInitialData deadline, honoring the test override. */
export function preresolveTotalTimeoutMs(): number {
  return preresolveTotalTimeoutMsOverride ?? PRERESOLVE_TOTAL_TIMEOUT_MS;
}

/** `e.message` for an Error, else its String() form (used only to compose an observability-hook message). */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A shared helper that preresolves a single effective ref with read (shared by buildSnapshot and preresolveInitialData).
 * Same ref-parsing style as resolve_binding: verify the source against base (reserved parameters removed), and merge the
 * reserved parameters (normally not present in a bind variant) into domain.invoke. An unknown source yields null (not an
 * embedding target). A domain.invoke failure is propagated to the caller rather than swallowed (the caller chooses total
 * failure or per-ref fail-open).
 */
async function resolveVariant(variant: string, ctx: ToolContext): Promise<TabularData | null> {
  // Pure parse/merge via host-core's parseInvokableRef (shared with the REST/MCP resolve_binding sites).
  // Deliberately no verify step here (see the module doc comment above) — an unknown source still yields
  // null (not an embedding target) rather than a thrown error.
  const parsed = parseInvokableRef(variant, ctx.deps.querySource);
  if (parsed.kind === "source_mismatch") return null;
  const { base, params } = parsed.ref;
  const resolved = await ctx.deps.domain.invoke(base.path, params, { principal: ctx.principal });
  return resolved as TabularData;
}

/**
 * Applies a per-ref timeout to resolveVariant. Rejects on exceeding timeoutMs and merges into the caller's
 * per-ref fail-open (skip + reportMcpError). Always cleans up the timer on either resolution or rejection so a hung
 * setTimeout does not keep holding the event loop.
 */
export async function resolveVariantWithTimeout(
  ref: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<TabularData | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Initial-data preresolution timed out (${timeoutMs}ms): ${ref}`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([resolveVariant(ref, ctx), timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * Enumerates each data-bearing component's effective refs: `initial` = the canonical raw of the component's
 * $ref itself (what resolveBoundRef returns in the initial state, its parseQueryRef().raw), `variants` = all
 * bind variants (the initial one included). The shared walk of snapshotHtmlFor / preresolveInitialData —
 * the resolution policy (flat full set vs initial-first budgeted) stays with each caller.
 */
export function collectComponentRefs(spec: UISpec): Array<{ initial: string; variants: string[] }> {
  const out: Array<{ initial: string; variants: string[] }> = [];
  for (const component of spec.components) {
    if (component.data == null) continue;
    out.push({
      initial: parseQueryRef(component.data.$ref).raw,
      variants: enumerateBindVariants(component.data),
    });
  }
  return out;
}

/**
 * Resolves `refs` with bounded concurrency (PRERESOLVE_CONCURRENCY workers pulling from a shared queue in
 * `refs` order) subject to an overall wall-clock deadline (`totalTimeoutMs`), returning each ref's resolved
 * TabularData (or absence, on per-ref failure / an unknown source / being cut off by the deadline).
 *
 * The queue order is preserved only for *starting* work (so, e.g., with concurrency 8 and 20 refs, the first 8
 * start immediately and the rest backfill as slots free up) — results land in the returned Map in whatever
 * order they complete, and preresolveInitialData re-imposes the deterministic initial-then-secondary budget
 * order itself when consuming the Map. This keeps the budget-cutoff behavior identical to the old serial loop
 * while letting the underlying DomainPort calls run concurrently.
 *
 * Once `totalTimeoutMs` elapses: no further refs are claimed from the queue (already-running ones are not
 * cancelled — DomainPort.invoke has no cancellation primitive — but the function stops waiting for them), and
 * this function returns with whatever has resolved so far. A still-in-flight resolution's eventual outcome
 * (success or failure) is discarded when it arrives — not written to the result Map — and reported through the
 * same per-ref fail-open onError path as an ordinary per-ref failure, with a message that identifies it as a
 * deadline discard rather than a genuine resolution error, so operators can tell the two apart in logs.
 *
 * Exported (beyond this module's own preresolveInitialData) so snapshot.ts's snapshotHtmlFor can share the
 * exact same bounded-concurrency / bounded-deadline resolution policy for the self-contained-snapshot ref set,
 * rather than the unbounded `Promise.all` it used to run on its own (see the module doc comment in
 * snapshot.ts).
 */
export async function resolveRefsBounded(
  refs: readonly string[],
  ctx: ToolContext,
  timeoutMs: number,
  totalTimeoutMs: number,
): Promise<Map<string, TabularData>> {
  const results = new Map<string, TabularData>();
  let deadlineExceeded = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      resolve();
    }, totalTimeoutMs);
  });

  let nextIndex = 0;
  const claimNext = (): number | null => {
    if (deadlineExceeded || nextIndex >= refs.length) return null;
    return nextIndex++;
  };

  const reportDiscard = async (ref: string, cause?: unknown): Promise<void> => {
    const detail = cause != null ? ` (${errorMessage(cause)})` : "";
    await notifyHook(ctx.deps.onError, {
      endpoint: "compose.initialData",
      error: new Error(
        `Initial-data preresolution discarded (total deadline ${totalTimeoutMs}ms exceeded before this ref resolved): ${ref}${detail}`,
      ),
    });
  };

  const resolveOne = async (ref: string): Promise<void> => {
    let resolved: TabularData | null;
    try {
      // per-ref timeout: do not let a dependency that stays pending and never returns hold up its slot forever.
      resolved = await resolveVariantWithTimeout(ref, ctx, timeoutMs);
    } catch (e) {
      if (deadlineExceeded) {
        await reportDiscard(ref, e);
      } else {
        // per-ref fail-open: do not drag down the whole compose because one reference's resolution failed
        // (exception/timeout). Skip it and report to the observation hook (a timeout is treated the same).
        // Same {endpoint, error} shape and swallow-on-throw semantics as server.ts's reportMcpError, via the
        // shared notifyHook building block directly (avoids a circular import back to server.ts).
        await notifyHook(ctx.deps.onError, { endpoint: "compose.initialData", error: e });
      }
      return;
    }
    if (deadlineExceeded) {
      // Resolved successfully, but too late: preresolveInitialData has already stopped waiting and moved on.
      await reportDiscard(ref);
      return;
    }
    if (resolved == null) return; // do not embed unknown sources
    results.set(ref, resolved);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = claimNext();
      if (index == null) return;
      await resolveOne(refs[index]!);
    }
  };

  const workerCount = Math.min(PRERESOLVE_CONCURRENCY, refs.length);
  const allSettled = Promise.all(Array.from({ length: workerCount }, () => worker())).then(() => {});
  // Whichever comes first: every worker has drained the queue, or the overall deadline has elapsed. In the
  // deadline case, workers already in the middle of resolveOne keep running in the background (their outcome
  // is handled — and discarded — by resolveOne itself above), but this function does not wait for them.
  await Promise.race([allSettled, deadline]);
  if (deadlineTimer != null) clearTimeout(deadlineTimer);
  return results;
}

/**
 * Preresolves the initial data `{ [effective ref]: TabularData }` co-embedded in a tool result's _meta.
 * - Within the budget (INITIAL_DATA_BUDGET_CHARS), resolves and embeds each component's initial variant ($ref itself)
 *   first, across all components, and fills the other bind variants with the remaining budget (initial display first).
 *   Anything over budget is not embedded.
 * - Refs are resolved with bounded concurrency (resolveRefsBounded, PRERESOLVE_CONCURRENCY workers) subject to
 *   an overall deadline (PRERESOLVE_TOTAL_TIMEOUT_MS), on top of the existing per-ref timeout — see both
 *   functions' docs. The budget is still applied afterward in the fixed initial-then-secondary order, exactly
 *   as when resolution was serial, so which refs end up embedded on overflow does not depend on completion
 *   order or on how many workers happened to be busy.
 * - per-ref fail-open: a preresolution domain.invoke failure (or a ref discarded by the overall deadline)
 *   skips that ref and reports to the observability hook (host-core's notifyHook — the compose result itself
 *   remains successful; this must not become a new failure surface).
 * The key is the effective ref's canonical raw (the renderer's fetcher looks up via resolveBoundRef → parseQueryRef().raw).
 *
 * Returns both the budget-trimmed `data` (the existing `_meta` co-embedding contract) and the full pre-budget
 * `resolved` Map, so a caller that also needs the same Spec's refs resolved for a second purpose (composeAndPackage's
 * legacyUiResource co-emission, via snapshotHtmlFor) can reuse this call's domain.invoke results instead of
 * resolving the identical ref set a second time.
 */
export async function preresolveInitialData(
  spec: UISpec,
  ctx: ToolContext,
): Promise<{ data: Record<string, TabularData>; resolved: Map<string, TabularData> }> {
  // Collect the initial variants across all components first, then the other bind variants (initial-display priority).
  const initialRefs: string[] = [];
  const secondaryRefs: string[] = [];
  for (const { initial, variants } of collectComponentRefs(spec)) {
    initialRefs.push(initial);
    for (const variant of variants) {
      if (variant !== initial) secondaryRefs.push(variant);
    }
  }

  // Dedup while preserving the initial-then-secondary priority order (the budget loop below walks this same
  // order), so a ref shared by several components/variants is resolved exactly once regardless of concurrency.
  const orderedRefs: string[] = [];
  const seenRefs = new Set<string>();
  for (const ref of [...initialRefs, ...secondaryRefs]) {
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    orderedRefs.push(ref);
  }

  const resolved = await resolveRefsBounded(
    orderedRefs,
    ctx,
    preresolveTimeoutMs(),
    preresolveTotalTimeoutMs(),
  );

  const data: Record<string, TabularData> = {};
  let used = 0;
  for (const ref of orderedRefs) {
    const value = resolved.get(ref);
    if (value == null) continue; // failed / timed out / unknown source / cut off by the overall deadline
    // Measure the budget (cumulative JSON characters), and once over budget, embed no more (partial embedding).
    // The budget contribution exactly equals JSON.stringify({ [ref]: resolved }).length (the 3 structural characters
    // `{`, `:`, `}` + the quoted key + the value). This avoids the waste of allocating and rebuilding a wrapper object each time.
    const size = JSON.stringify(value).length + JSON.stringify(ref).length + 3;
    if (used + size > INITIAL_DATA_BUDGET_CHARS) break;
    used += size;
    data[ref] = value;
  }
  return { data, resolved };
}
