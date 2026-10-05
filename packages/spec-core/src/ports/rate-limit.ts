/**
 * A token-bucket rate-limit rule: `capacity` tokens, refilled continuously at `refillPerSecond`.
 * Structurally identical to the Policy-as-Code file's `rateLimits` section shape
 * (schema/policy.ts's `PolicyRateLimitRuleSchema`), kept as an independent type here rather than
 * imported from it: `ports.ts` is the framework-boundary contract and should not depend on any one
 * schema representation of the same shape.
 */
export interface RateLimitRule {
  capacity: number;
  refillPerSecond: number;
}

/** Outcome of `RateLimitStore.take`. */
export interface RateLimitResult {
  allow: boolean;
  /**
   * Suggested backoff before retrying, in milliseconds (SPEC §6.1, REST-RL-001). Present only when
   * `allow` is false.
   */
  retryAfterMs?: number;
}

/**
 * A token-bucket rate-limit store, keyed by an opaque caller-supplied string (host-core's
 * `createRateLimiter` composes it as the `JSON.stringify` of the array `[tenant, principal, routeClass]` — see
 * that function's own doc).
 * A Port reference implementation (host-core's `createMemoryRateLimitStore`, the in-process default)
 * and future backing-store adapters (Redis, etc.) all implement this same shape, verified against
 * `@kohaku-ui/port-contracts`' `describeRateLimitStorePortContract`.
 *
 * **Concurrency contract**: like `StoragePort`, this carries no cross-process locking of its own — a
 * distributed backing store is expected to implement `take` atomically on its own side (e.g. a single
 * Lua script / transaction against Redis), not rely on the caller to serialize it.
 */
export interface RateLimitStore {
  /**
   * Attempts to consume `cost` tokens from the bucket identified by `key`, under `rule`. `nowMs` is the
   * caller-supplied wall-clock time (epoch milliseconds) — the store never reads the clock itself,
   * keeping `take` a pure/deterministic function of its arguments (the same contract as composer's
   * `checkBudget`'s `elapsedMs`), so a caller can inject a fixed clock in tests.
   *
   * On denial, `retryAfterMs` estimates the wait until enough tokens will have refilled for this same
   * request to succeed.
   *
   * `nowMs` comes from each caller's own clock, so callers of one distributed store can disagree. The
   * store must not let that skew over-refill a bucket: keep the stored last-refill time monotonic (never
   * move it backwards to a smaller `nowMs`) or use the backing store's own clock instead.
   */
  take(key: string, cost: number, rule: RateLimitRule, nowMs: number): Promise<RateLimitResult>;
}
