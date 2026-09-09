/**
 * Exponential backoff with jitter, limited to transient PROVIDER failures (429 / 5xx and the like — API errors
 * that the AI SDK judges as `isRetryable=true`). This single file centrally manages the retry policy, and the
 * SDK's built-in retries (default maxRetries=2) are pinned to 0 by the caller to avoid double retries.
 *
 * Design-level separation:
 * - ABORTED (caller cancellation / timeout overrun) propagates immediately and is not retried.
 * - INVALID_OUTPUT / CONFIG are out of scope (schema-derived failures are not fixed by retrying).
 * - PROVIDER with `isRetryable=false` (e.g. ollama's structured-output 400) is also out of scope. That is a
 *   structured-output incompatibility, which is the prompt JSON fallback's (auto) job. Retrying here would be a
 *   "fallback × backoff" double consumption, so it propagates immediately.
 * - The whole sequence never exceeds timeoutMs (deadline). If the next wait would not fit the remaining budget, stop.
 */
import type { RetryPolicy } from "../env.js";

/** Side effects that can be injected externally for determinism (tests swap wait / time / randomness). */
export interface RetryDeps {
  /** A wait that respects the AbortSignal. On abort, rejects with signal.reason. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  /** Uniform random in [0,1) (for jitter). */
  random: () => number;
}

export const defaultRetryDeps: RetryDeps = {
  sleep: defaultSleep,
  now: () => Date.now(),
  random: () => Math.random(),
};

/** setTimeout-based wait that respects the AbortSignal. On abort, rejects with signal.reason. */
export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Do not let a backoff wait keep the process alive on shutdown (abort still clears the timer; optional
    // call because non-Node runtimes return a number here).
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `fn` and, on a retryable PROVIDER failure, retries with exponential backoff.
 * Everything else (abort / non-retryable PROVIDER / schema-derived, etc.) is not caught and re-thrown as is.
 */
export async function withProviderRetry<T>(
  fn: () => Promise<T>,
  opts: {
    policy: RetryPolicy;
    signal: AbortSignal;
    /** Deadline for retry scheduling (absolute time in milliseconds). Given as now() + timeoutMs. */
    deadline: number;
    deps?: Partial<RetryDeps>;
  },
): Promise<T> {
  const { policy, signal, deadline } = opts;
  const deps: RetryDeps = { ...defaultRetryDeps, ...opts.deps };
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      // Do not retry on abort / timeout (if the shared signal has expired, further attempts are pointless too).
      if (isAbortLike(err, signal)) throw err;
      const retryAfterMs = retryableProviderError(err);
      // Not retryable, or the limit is reached, so propagate immediately.
      if (retryAfterMs === undefined || attempt >= policy.maxRetries) throw err;
      const waitMs = nextDelayMs(policy, attempt, retryAfterMs, deps.random);
      // If waiting would only cross the deadline and be timeout-aborted right after, give up now without waiting.
      if (deps.now() + waitMs >= deadline) throw err;
      await deps.sleep(waitMs, signal);
      attempt += 1;
    }
  }
}

/** Whether the error stems from an abort / timeout (judged by name or signal expiry). */
function isAbortLike(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * The next backoff wait (milliseconds). If the provider returned a Retry-After, respect it;
 * otherwise add ±jitter perturbation to base = initialDelayMs * factor^attempt.
 */
export function nextDelayMs(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs: number | null,
  random: () => number,
): number {
  if (retryAfterMs != null) return Math.max(0, Math.round(retryAfterMs));
  const base = policy.initialDelayMs * policy.backoffFactor ** attempt;
  // Map random() ∈ [0,1) to [-1,1) and perturb by a ratio of base.
  const delta = (random() * 2 - 1) * policy.jitter * base;
  return Math.max(0, Math.round(base + delta));
}

/**
 * Judges whether a PROVIDER failure is retryable and, if so, returns the Retry-After (milliseconds).
 * - undefined: not retryable (non-APICallError / isRetryable=false / schema-derived, etc.)
 * - null: retryable, no Retry-After (leave it to exponential backoff)
 * - number: retryable, Retry-After present (respect this wait)
 */
export function retryableProviderError(err: unknown): number | null | undefined {
  const api = findApiCallError(err);
  if (api == null || api.isRetryable !== true) return undefined;
  return retryAfterFromHeaders(api.responseHeaders);
}

/** Whether a PROVIDER failure is retryable (the boolean version used for the auto fallback branch decision). */
export function isRetryableProviderError(err: unknown): boolean {
  return retryableProviderError(err) !== undefined;
}

interface ApiCallErrorLike {
  isRetryable?: unknown;
  responseHeaders?: Record<string, string>;
  statusCode?: unknown;
  url?: unknown;
  cause?: unknown;
}

/**
 * Structurally searches for the AI SDK's APICallError (without adding a direct dependency on
 * `@ai-sdk/provider`; also follows cause). An APICallError always has `isRetryable` (boolean). To avoid
 * false positives with other boolean fields, it is required to also carry one of responseHeaders / statusCode / url.
 */
function findApiCallError(err: unknown, depth = 0): ApiCallErrorLike | undefined {
  if (err == null || typeof err !== "object" || depth > 4) return undefined;
  const e = err as ApiCallErrorLike;
  if (typeof e.isRetryable === "boolean" && ("responseHeaders" in e || "statusCode" in e || "url" in e)) {
    return e;
  }
  return findApiCallError(e.cause, depth + 1);
}

/** Interprets Retry-After-equivalent headers (retry-after-ms / retry-after). Follows the AI SDK's implementation. */
function retryAfterFromHeaders(headers: Record<string, string> | undefined): number | null {
  if (headers == null) return null;
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs != null) {
    const ms = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter != null) {
    // Seconds (e.g. "2") or an HTTP date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT").
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateMs) && dateMs >= 0) return dateMs;
  }
  return null;
}
