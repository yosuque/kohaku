/**
 * A minimal worker-pool `map`: runs `fn` over `items` with at most `limit` calls in flight at once, instead of
 * either fully sequential (one at a time) or fully unbounded (`Promise.all`, all at once) concurrency. No new
 * dependency — a handful of `while` loops racing over a shared cursor.
 *
 * Used by promotion/nomination.ts to bound `suggestSchema` extraction concurrency (#15): unbounded `Promise.all`
 * across a whole scan's freshly nominated candidates meant a burst of N candidates fired N simultaneous LLM
 * calls, all held open inside the tenant's promotion governance mutex (`evaluateAndList` runs inside
 * host-rest's per-tenant lock) — an accidental amplifier of both the LLM provider's own rate limits and how long
 * that lock stays held. `limit` puts a ceiling on both.
 *
 * Order is preserved in the returned array regardless of which worker happens to finish which item first
 * (`results[index]` is written by index, not push order). A rejection from any single call rejects the whole
 * `mapWithConcurrency` call (the same all-or-nothing failure contract as `Promise.all`) — callers that need a
 * per-item fail-open contract (e.g. nomination.ts's `suggestFailOpen`) must make `fn` itself never reject.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  // Never spawn more workers than there is work for, and always at least one: a non-finite (NaN/±Infinity) or
  // non-positive limit is treated as 1 rather than silently doing nothing or spawning an unbounded number.
  const safeLimit = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workerCount = Math.max(1, Math.min(safeLimit, items.length));
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
