import type { RateLimitResult, RateLimitRule, RateLimitStore } from "@kohaku-ui/spec-core";
import { notifyHook } from "./errors.js";

/** One key's token-bucket state (createMemoryRateLimitStore's internal bookkeeping). */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** A sensible default cap on the number of distinct buckets/ledger entries an in-process, Map-backed store keeps at once — see `createMemoryRateLimitStore`/`createDailyTokenLedger`'s `maxEntries`. */
export const DEFAULT_MAX_MEMORY_ENTRIES = 10_000;

export interface CreateMemoryRateLimitStoreOptions {
  /**
   * Caps the number of distinct buckets kept at once. Once the cap is reached, adding a bucket for a
   * new key evicts the least-recently-used one first (an existing key's own bucket is never evicted by
   * this, only reordered to most-recently-used on every `take`). Default `DEFAULT_MAX_MEMORY_ENTRIES`
   * (10,000). See the function's own doc for why this bound exists.
   */
  maxEntries?: number;
}

/**
 * A pure in-process token-bucket `RateLimitStore` (the Zero-Port default, and the reference
 * implementation `@kohaku-ui/port-contracts`' `describeRateLimitStorePortContract` exercises).
 * Mirrors `storage-memory`'s `createMemoryStoragePort` in spirit: state lives only in this process and
 * is lost on restart, with no cross-process coordination — a product running several host instances
 * needs a shared backing store (Redis, etc.) implementing the same `RateLimitStore` contract instead.
 *
 * A key's bucket starts full (`rule.capacity` tokens) on first use, refills continuously at
 * `rule.refillPerSecond` (capped at `rule.capacity`), and never actively expires on its own — a key
 * that stops being used would otherwise keep its bucket forever, so the map would grow with the number
 * of distinct keys ever seen (unbounded for a product with unboundedly many keys, e.g. one bucket per
 * anonymous IP or per rotated header value). `maxEntries` (default `DEFAULT_MAX_MEMORY_ENTRIES`) bounds
 * that growth with LRU eviction: a `Map` iterates in insertion order, and every `take` call deletes then
 * re-inserts the accessed key, so the first key in iteration order is always the least-recently-used
 * one — evicted only when a brand-new key would otherwise push the map over the cap. A rate limit is
 * only as strong as the identity it keys on: see docs/user-guide.md's Policy-as-Code section for why an
 * unauthenticated caller that can vary its own tenant/principal header can just as easily rotate through
 * buckets as it can exhaust this cap.
 */
export function createMemoryRateLimitStore(options: CreateMemoryRateLimitStoreOptions = {}): RateLimitStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;
  const buckets = new Map<string, Bucket>();
  return {
    async take(key, cost, rule, nowMs) {
      const existing = buckets.get(key);
      let bucket: Bucket;
      if (existing != null) {
        buckets.delete(key); // reinsert below to mark as most-recently-used
        const elapsedSeconds = Math.max(0, nowMs - existing.lastRefillMs) / 1000;
        bucket = {
          tokens: Math.min(rule.capacity, existing.tokens + elapsedSeconds * rule.refillPerSecond),
          lastRefillMs: nowMs,
        };
      } else {
        bucket = { tokens: rule.capacity, lastRefillMs: nowMs };
        if (buckets.size >= maxEntries) {
          const oldestKey = buckets.keys().next().value;
          if (oldestKey !== undefined) buckets.delete(oldestKey);
        }
      }
      buckets.set(key, bucket);
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
 * Builds a `RateLimiter` over a `RateLimitStore`, keying each bucket by the canonical JSON array
 * `[tenant, principal, routeClass]` (tenant/principal default to the empty string when unset, so an
 * anonymous caller still gets its own bucket per tenant/routeClass rather than colliding with every
 * other anonymous caller across route classes — the MCP profile's "no tenant, no principal" case, task
 * 11, still separates `compose` from `action` this way).
 *
 * **Not a delimiter-joined string** (e.g. `` `${tenant}:${principal}:${routeClass}` ``): a plain colon
 * join collides whenever a component itself contains the delimiter — `(tenant: "a:b", principal: "c")`
 * and `(tenant: "a", principal: "b:c")` would both join to `"a:b:c:<routeClass>"` and share a bucket,
 * letting one caller's usage count against (or be undercounted against) another's. `JSON.stringify`
 * escapes any `"`/`:`/control character inside a component, so two distinct triples can never encode to
 * the same string; the Python port uses `json.dumps(..., separators=(",", ":"))` for a byte-identical
 * encoding (both drop the whitespace `json.dumps` adds by default, matching `JSON.stringify`'s own
 * no-whitespace output) — not that cross-language key equality itself matters (each language's
 * in-process `RateLimitStore` never shares state with the other's), just that a divergent encoding isn't
 * left as a subtle trap for a future shared backing store.
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
      const key = JSON.stringify([tenant ?? "", principal ?? "", routeClass]);
      try {
        return await store.take(key, cost, rule, now());
      } catch (error) {
        await notifyHook(onError, { error, tenant, principal, routeClass });
        return { allow: true };
      }
    },
  };
}
