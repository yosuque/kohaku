import type { ComposeBudget } from "./context.js";
import type { ComposeAttempt } from "./trace.js";

/** Result of a budget check. When allow:false, reason carries the downgrade reason (the value placed on fallback.reason). */
export interface BudgetVerdict {
  allow: boolean;
  reason?: string;
}

/**
 * Decide whether we may make one more LLM call (a token/call/deadline budget guard). Call timing is
 * immediately before an LLM call (before L1 generation, before repair, before L2). When budget is
 * unspecified, always allow (backward compatible, performance unchanged).
 *
 * - perCompose: reject when the accumulated usage so far (spent) is at or above stopAfterTokens
 *   (0 rejects from the first call). This is a **threshold that stops additional calls**, not a hard
 *   cap on total tokens — a single call may exceed the threshold by a wide margin without being
 *   stopped beforehand (an LLM's output size cannot be determined in advance), and the overage is
 *   visible after the fact via trace.usage.
 * - deadlineMs: reject when the elapsed wall-clock time (elapsedMs, supplied by the caller — this function
 *   never calls Date.now() itself, keeping it a pure/deterministic function of its arguments) is at or past
 *   the configured deadline. Like perCompose, this is a **threshold that stops additional calls, not a hard
 *   cap on one call's duration** — a call already in flight when the deadline elapses is not interrupted by
 *   this function (see budget.ts's createDeadlineGuard for the separate in-flight abort mechanism that
 *   covers that case). elapsedMs is ignored (no deadline check performed) when either it or
 *   budget.deadlineMs is unset, so a caller that never measures elapsed time sees no behavior change.
 * - check: a global budget hook supplied by the product. When it returns allow:false, its reason is
 *   adopted. A throw is swallowed and passed through (allow) — so that we do not drop every UI to a
 *   fallback when the budget state cannot be determined. The swallowed throw is forwarded to
 *   onCheckError (when specified) to keep it observable (no unobserved fail-open).
 *
 * perCompose is checked first, then deadlineMs, then check() (each earlier check short-circuits the
 * later ones). Even when several are involved, the first one to reject wins and is placed on reason —
 * perCompose's token-threshold reason takes precedence over a simultaneous deadline overage.
 */
export function checkBudget(
  budget: ComposeBudget | undefined,
  spent: number,
  onCheckError?: (error: unknown) => void,
  elapsedMs?: number,
): BudgetVerdict {
  if (budget == null) return { allow: true };
  const max = budget.perCompose?.stopAfterTokens;
  if (max != null && spent >= max) {
    return { allow: false, reason: `Budget exceeded: token threshold ${max} reached (spent ${spent})` };
  }
  const deadlineMs = budget.deadlineMs;
  if (deadlineMs != null && elapsedMs != null && elapsedMs >= deadlineMs) {
    return {
      allow: false,
      reason: `Budget exceeded: deadline ${deadlineMs}ms reached (elapsed ${elapsedMs}ms)`,
    };
  }
  if (budget.check != null) {
    let verdict: { allow: boolean; reason?: string };
    try {
      verdict = budget.check();
    } catch (e) {
      // Do not break compose on a throw from the budget hook. When undecidable, pass through (continue generation).
      // Forward the occurrence to onCheckError to keep it observable (do not leave the fail-open unobserved).
      onCheckError?.(e);
      return { allow: true };
    }
    if (!verdict.allow) {
      return {
        allow: false,
        reason: verdict.reason ?? "Budget exceeded: generation skipped by budget hook",
      };
    }
  }
  return { allow: true };
}

/** Sum of the attempts' usage (input+output). Used as spent in the budget check. An attempt without usage counts as 0. */
export function sumSpentTokens(attempts: ComposeAttempt[]): number {
  let total = 0;
  for (const a of attempts) {
    if (a.usage == null) continue;
    total += a.usage.inputTokens + a.usage.outputTokens;
  }
  return total;
}

/**
 * The abort signal + disposer produced by createDeadlineGuard for one compose-wide deadline. `signal` is
 * what generateL1/generateL2 must pass to the LLM call in place of the caller's own abort signal;
 * `deadlineSignal` is a second, narrower signal used only to tell "the deadline fired" apart from "the
 * caller's own AbortSignal (or the per-call KOHAKU_LLM_TIMEOUT_MS floor) fired" at the classification site
 * in tiers/shared.ts's runRepairLoop.
 */
export interface DeadlineGuard {
  /**
   * The signal to pass to LLM calls: the caller's own abort signal combined (via AbortSignal.any) with a
   * timer that fires once `budget.deadlineMs` elapses. Identical to `callerSignal` — the same reference,
   * not merely equivalent — whenever `budget?.deadlineMs` is unset, so a caller that never sets it is
   * byte-identical to before this guard existed.
   */
  signal: AbortSignal | undefined;
  /**
   * Fires only when the compose-wide deadline elapses (never by callerSignal aborting on its own).
   * Undefined whenever `budget?.deadlineMs` is unset. Checking `deadlineSignal.aborted` after catching an
   * `ABORTED` LlmError is how the deadline is told apart from a genuine client cancellation.
   */
  deadlineSignal: AbortSignal | undefined;
  /** Clears the underlying timer. Must be called once generation settles (success or fallback), in a
   * `finally`, so a deadline that never fires does not leave a dangling timer. A no-op when no timer was armed. */
  dispose(): void;
}

/**
 * Arms the compose-wide deadline (`ComposeBudget.deadlineMs`), once per compose, shared across the whole
 * L1→L2 ladder (the initial L1 call, every repair re-attempt, and L2) rather than reset per attempt — so it
 * bounds the wall-clock time of the *compose*, not any single LLM call. Called from tier-ladder.ts's
 * runTierGeneration; disposed in that same function's `finally` once the ladder settles.
 *
 * Between-call enforcement (checkBudget's `elapsedMs` check, run immediately before each LLM call) already
 * stops the ladder from *starting* another call once the deadline has passed. This guard additionally covers
 * the case where a call is already in flight when the deadline elapses mid-call: the timer aborts `signal`,
 * which is threaded into the LLM call as `req.abort` exactly like `callerSignal` was before, so the call
 * rejects with an `LlmError` (code `ABORTED`) the same way a caller cancellation does. What differs is
 * classification: `deadlineSignal` — armed by nothing else — lets runRepairLoop tell that this particular
 * `ABORTED` came from the deadline (and must be treated as a budget-guard fallback, counted in the
 * generation-fallback rate) rather than from the caller's own signal (a client disconnect, excluded from
 * that rate — see docs/design.md §5).
 *
 * `now` is injectable for tests (default `Date.now`); pass a fixed value to construct a guard with a
 * predetermined remaining duration without depending on wall-clock time at test-run time.
 */
export function createDeadlineGuard(
  budget: ComposeBudget | undefined,
  startedAt: number,
  callerSignal: AbortSignal | undefined,
  now: () => number = Date.now,
): DeadlineGuard {
  const deadlineMs = budget?.deadlineMs;
  if (deadlineMs == null) {
    return { signal: callerSignal, deadlineSignal: undefined, dispose(): void {} };
  }
  const remainingMs = Math.max(0, deadlineMs - (now() - startedAt));
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), remainingMs);
  // Node's Timeout keeps the event loop alive; unref so an outstanding deadline never blocks process exit
  // (mirrors AbortSignal.timeout's own fire-and-forget nature, used the same way in the LLM adapter).
  // Optional chaining: some runtimes (e.g. Cloudflare Workers, browsers) return a plain number with no
  // unref method from setTimeout — this is a harmless no-op there.
  (timer as { unref?: () => void }).unref?.();
  const signal =
    callerSignal != null
      ? AbortSignal.any([callerSignal, deadlineController.signal])
      : deadlineController.signal;
  return {
    signal,
    deadlineSignal: deadlineController.signal,
    dispose(): void {
      clearTimeout(timer);
    },
  };
}
