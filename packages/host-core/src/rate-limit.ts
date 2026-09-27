import type { RateLimitResult, RateLimitRule, RateLimitStore } from "@kohaku-ui/spec-core";
import { notifyHook } from "./errors.js";

/** One key's token-bucket state (createMemoryRateLimitStore's internal bookkeeping). */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * A pure in-process token-bucket `RateLimitStore` (the Zero-Port default, and the reference
 * implementation `@kohaku-ui/port-contracts`' `describeRateLimitStorePortContract` exercises).
 * Mirrors `storage-memory`'s `createMemoryStoragePort` in spirit: state lives only in this process and
 * is lost on restart, with no cross-process coordination — a product running several host instances
 * needs a shared backing store (Redis, etc.) implementing the same `RateLimitStore` contract instead.
 *
 * A key's bucket starts full (`rule.capacity` tokens) on first use, refills continuously at
 * `rule.refillPerSecond` (capped at `rule.capacity`), and never actively expires — a key that stops
 * being used simply stops accumulating history beyond `rule.capacity`, so the map does grow with the
 * number of distinct keys ever seen. A product with unboundedly many keys (e.g. one bucket per
 * anonymous IP) should prefer a backing store with its own eviction instead.
 */
export function createMemoryRateLimitStore(): RateLimitStore {
  const buckets = new Map<string, Bucket>();
  return {
    async take(key, cost, rule, nowMs) {
      let bucket = buckets.get(key);
      if (bucket == null) {
        bucket = { tokens: rule.capacity, lastRefillMs: nowMs };
        buckets.set(key, bucket);
      } else {
        const elapsedSeconds = Math.max(0, nowMs - bucket.lastRefillMs) / 1000;
        bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
        bucket.lastRefillMs = nowMs;
      }
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return { allow: true };
      }
      const shortfall = cost - bucket.tokens;
      return { allow: false, retryAfterMs: Math.ceil((shortfall / rule.refillPerSecond) * 1000) };
    },
  };
}

/** Parameters for one `RateLimiter.take` call. */
export interface RateLimiterTakeParams {
  /** `SessionContext.tenant`. Unset = tenant-neutral (a single shared bucket across tenants for this principal/routeClass). */
  tenant?: string;
  /** The caller's principal id (e.g. `Principal.id`). Unset = a single shared bucket across principals for this tenant/routeClass (the anonymous-caller case). */
  principal?: string;
  /** The route class the rule applies to (e.g. "compose" / "action" / "resolve" — see the Policy file's `rateLimits` section, schema/policy.ts). */
  routeClass: string;
  rule: RateLimitRule;
  /** Tokens to consume for this call. Default 1. */
  cost?: number;
}

export interface RateLimiter {
  take(params: RateLimiterTakeParams): Promise<RateLimitResult>;
}

/** Info passed to `createRateLimiter`'s `onError` when the backing store's `take` throws. */
export interface RateLimiterErrorInfo {
  error: unknown;
  tenant?: string;
  principal?: string;
  routeClass: string;
}

/**
 * Builds a `RateLimiter` over a `RateLimitStore`, keying each bucket by
 * `"${tenant}:${principal}:${routeClass}"` (tenant/principal default to the empty string when unset,
 * so an anonymous caller still gets its own bucket per tenant/routeClass rather than colliding with
 * every other anonymous caller across route classes — the MCP profile's "no tenant, no principal"
 * case, task 11, still separates `compose` from `action` this way).
 *
 * **Fail-open** on a store error: the request is allowed through (`{ allow: true }`), and the error is
 * reported via `onError` (silent, fire-and-forget, if unwired — the same `notifyHook` convention as
 * `ComposeObserver`'s hooks) rather than left unobserved or turned into a hard failure. A rate limiter
 * outage must never itself become a reason no request can be served.
 */
export function createRateLimiter(
  store: RateLimitStore,
  onError?: (info: RateLimiterErrorInfo) => void | Promise<void>,
  now: () => number = Date.now,
): RateLimiter {
  return {
    async take({ tenant, principal, routeClass, rule, cost = 1 }): Promise<RateLimitResult> {
      const key = `${tenant ?? ""}:${principal ?? ""}:${routeClass}`;
      try {
        return await store.take(key, cost, rule, now());
      } catch (error) {
        await notifyHook(onError, { error, tenant, principal, routeClass });
        return { allow: true };
      }
    },
  };
}
