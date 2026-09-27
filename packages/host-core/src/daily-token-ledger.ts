import { DEFAULT_MAX_MEMORY_ENTRIES } from "./rate-limit.js";

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

export interface CreateDailyTokenLedgerOptions {
  /**
   * Caps the number of distinct keys kept at once. Once the cap is reached, recording against a new key
   * evicts the least-recently-touched one first (`spent`/`record` both count as a touch); an existing
   * key's own entry is never evicted by this, only reordered to most-recently-used. Default
   * `DEFAULT_MAX_MEMORY_ENTRIES` (10,000, the same default `createMemoryRateLimitStore` uses).
   */
  maxEntries?: number;
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
 *
 * Bounded memory (`maxEntries`, default `DEFAULT_MAX_MEMORY_ENTRIES`): without a cap, a key that stops
 * being used would keep its entry forever, so the map would grow with the number of distinct keys ever
 * seen (unbounded for a product with unboundedly many tenants/keys). Eviction is LRU, the same scheme
 * `createMemoryRateLimitStore` uses (a `Map` iterates in insertion order, and every touch deletes then
 * re-inserts the key, so the first key in iteration order is always the least-recently-touched one).
 * Separately, entries for a UTC day that has already ended are dead weight regardless of `maxEntries` --
 * on the first call after the day rolls over, every entry whose stored `day` differs from the new day is
 * swept out in one pass (not checked per call), rather than waiting for LRU pressure to evict them.
 */
export function createDailyTokenLedger(
  now: () => number = Date.now,
  options: CreateDailyTokenLedgerOptions = {},
): DailyTokenLedger {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;
  const entries = new Map<string, LedgerEntry>();
  let lastKnownDay: string | undefined;

  /** Sweeps out every entry from a UTC day other than `day`, once per day (a no-op after the first call of a given day). */
  function pruneOnRollover(day: string): void {
    if (lastKnownDay === day) return;
    lastKnownDay = day;
    for (const [key, entry] of entries) {
      if (entry.day !== day) entries.delete(key);
    }
  }

  /** Moves `key` to the most-recently-used position (the end of the Map's iteration order). */
  function touch(key: string, entry: LedgerEntry): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  return {
    spent(key) {
      const day = utcDay(now());
      pruneOnRollover(day);
      const entry = entries.get(key);
      if (entry == null || entry.day !== day) return 0;
      return entry.spentTokens;
    },
    record(key, tokens) {
      const day = utcDay(now());
      pruneOnRollover(day);
      const existing = entries.get(key);
      if (existing != null && existing.day === day) {
        existing.spentTokens += tokens;
        touch(key, existing);
        return;
      }
      // A brand-new key, or an existing key whose entry is from a previous day (reset, not
      // accumulated) -- either way this is a fresh entry for today. A genuinely new key may need to
      // evict something to make room; an existing (stale) key is deleted first so re-inserting it
      // below also moves it to the most-recently-used position, instead of leaving it at whatever
      // position its now-overwritten previous-day entry happened to occupy.
      if (existing == null) {
        if (entries.size >= maxEntries) {
          const oldestKey = entries.keys().next().value;
          if (oldestKey !== undefined) entries.delete(oldestKey);
        }
      } else {
        entries.delete(key);
      }
      entries.set(key, { day, spentTokens: tokens });
    },
  };
}
