/**
 * An in-process, per-key cumulative token ledger scoped to the current UTC calendar day. Backs a
 * `ComposeBudget.check`/`onUsage` pair for a daily token budget (the Policy file's
 * `compose.budget.dailyTokens`, schema/policy.ts) — `createPolicyRuntime` (host-core) is the intended
 * caller: `check` reads `spent(tenant)` and denies once it reaches `dailyTokens`, `onUsage` calls
 * `record(tenant, usage.inputTokens + usage.outputTokens)` after a compose that actually generated.
 *
 * State lives only in this process and is lost on restart (the Zero-Port default, like
 * `createMemoryRateLimitStore`) — a product running several host instances, or that needs the ledger to
 * survive a restart, needs a shared backing store instead.
 */
export interface DailyTokenLedger {
  /** The current UTC day's cumulative tokens recorded for `key` (0 if the day has rolled over since the last `record`, or `key` is new). */
  spent(key: string): number;
  /**
   * Adds `tokens` to `key`'s running total for the UTC day containing the ledger's current time. Rolls
   * over automatically: if the stored day for `key` differs from today's (UTC), the total resets to
   * `tokens` rather than accumulating onto yesterday's figure.
   */
  record(key: string, tokens: number): void;
}

/** One key's ledger entry: the UTC day (`YYYY-MM-DD`) the running total was last recorded against. */
interface LedgerEntry {
  day: string;
  spentTokens: number;
}

/** `YYYY-MM-DD` in UTC (`Date.prototype.toISOString` always renders UTC, so a plain slice suffices). */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Builds a `DailyTokenLedger`. `now` is injectable (default `Date.now`), the same convention as
 * `createRateLimiter`'s clock parameter — pass a mutable closure in tests to move the ledger across a
 * day boundary without depending on wall-clock time at test-run time.
 */
export function createDailyTokenLedger(now: () => number = Date.now): DailyTokenLedger {
  const entries = new Map<string, LedgerEntry>();
  return {
    spent(key) {
      const entry = entries.get(key);
      if (entry == null || entry.day !== utcDay(now())) return 0;
      return entry.spentTokens;
    },
    record(key, tokens) {
      const day = utcDay(now());
      const entry = entries.get(key);
      if (entry == null || entry.day !== day) {
        entries.set(key, { day, spentTokens: tokens });
      } else {
        entry.spentTokens += tokens;
      }
    },
  };
}
