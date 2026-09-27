import type { RateLimitStore } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createMemoryRateLimitStore, createRateLimiter } from "../src/rate-limit.js";

describe("createMemoryRateLimitStore", () => {
  it("allows up to capacity, then denies", async () => {
    const store = createMemoryRateLimitStore();
    const rule = { capacity: 3, refillPerSecond: 1 };
    for (let i = 0; i < 3; i++) {
      expect(await store.take("k", 1, rule, 0)).toEqual({ allow: true });
    }
    const denied = await store.take("k", 1, rule, 0);
    expect(denied.allow).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time, capped at capacity", async () => {
    const store = createMemoryRateLimitStore();
    const rule = { capacity: 2, refillPerSecond: 1 }; // 1 token/sec

    expect(await store.take("k", 2, rule, 0)).toEqual({ allow: true }); // drains to 0
    expect((await store.take("k", 1, rule, 0)).allow).toBe(false); // still 0 at t=0

    // 500ms later: 0.5 tokens refilled, still not enough for cost 1.
    expect((await store.take("k", 1, rule, 500)).allow).toBe(false);

    // 1000ms later (total 1.5s elapsed): 1.5 tokens refilled, enough for cost 1.
    expect((await store.take("k", 1, rule, 1500)).allow).toBe(true);

    // Refilling for a long time never exceeds capacity: only 2 tokens are available, not more.
    expect((await store.take("k", 2, rule, 1_000_000)).allow).toBe(true);
    expect((await store.take("k", 1, rule, 1_000_000)).allow).toBe(false);
  });

  it("retryAfterMs reflects the shortfall at the refill rate", async () => {
    const store = createMemoryRateLimitStore();
    const rule = { capacity: 1, refillPerSecond: 2 }; // 2 tokens/sec
    await store.take("k", 1, rule, 0); // drains to 0
    const denied = await store.take("k", 1, rule, 0);
    expect(denied.allow).toBe(false);
    // Needs 1 full token at 2/sec = 500ms.
    expect(denied.retryAfterMs).toBe(500);
  });

  it("keys are independent buckets", async () => {
    const store = createMemoryRateLimitStore();
    const rule = { capacity: 1, refillPerSecond: 1 };
    expect((await store.take("a", 1, rule, 0)).allow).toBe(true);
    expect((await store.take("a", 1, rule, 0)).allow).toBe(false);
    expect((await store.take("b", 1, rule, 0)).allow).toBe(true); // unaffected by "a"
  });

  it("a zero-capacity rule denies from the first call", async () => {
    const store = createMemoryRateLimitStore();
    const rule = { capacity: 0, refillPerSecond: 1 };
    expect((await store.take("k", 1, rule, 0)).allow).toBe(false);
  });
});

describe("createRateLimiter", () => {
  const RULE = { capacity: 1, refillPerSecond: 1 };

  it("keys buckets by tenant:principal:routeClass", async () => {
    const limiter = createRateLimiter(createMemoryRateLimitStore(), undefined, () => 0);
    expect(
      (await limiter.take({ tenant: "t1", principal: "p1", routeClass: "compose", rule: RULE })).allow,
    ).toBe(true);
    // Same tenant/principal, different routeClass: independent bucket.
    expect(
      (await limiter.take({ tenant: "t1", principal: "p1", routeClass: "action", rule: RULE })).allow,
    ).toBe(true);
    // Same tenant/principal/routeClass again: bucket now exhausted.
    expect(
      (await limiter.take({ tenant: "t1", principal: "p1", routeClass: "compose", rule: RULE })).allow,
    ).toBe(false);
    // Different tenant, same principal/routeClass: independent bucket.
    expect(
      (await limiter.take({ tenant: "t2", principal: "p1", routeClass: "compose", rule: RULE })).allow,
    ).toBe(true);
  });

  it("an anonymous caller (no tenant/principal) still separates by routeClass", async () => {
    const limiter = createRateLimiter(createMemoryRateLimitStore(), undefined, () => 0);
    expect((await limiter.take({ routeClass: "compose", rule: RULE })).allow).toBe(true);
    expect((await limiter.take({ routeClass: "compose", rule: RULE })).allow).toBe(false);
    expect((await limiter.take({ routeClass: "action", rule: RULE })).allow).toBe(true);
  });

  it("defaults cost to 1", async () => {
    const limiter = createRateLimiter(createMemoryRateLimitStore(), undefined, () => 0);
    expect(
      (await limiter.take({ routeClass: "compose", rule: { capacity: 1, refillPerSecond: 1 } })).allow,
    ).toBe(true);
    expect(
      (await limiter.take({ routeClass: "compose", rule: { capacity: 1, refillPerSecond: 1 } })).allow,
    ).toBe(false);
  });

  it("is fail-open on a store error, reporting it via onError", async () => {
    const boom = new Error("rate limit store outage (test)");
    const brokenStore: RateLimitStore = {
      take: () => Promise.reject(boom),
    };
    const reported: unknown[] = [];
    const limiter = createRateLimiter(
      brokenStore,
      (info) => {
        reported.push(info);
      },
      () => 0,
    );

    const result = await limiter.take({ tenant: "t1", principal: "p1", routeClass: "compose", rule: RULE });
    expect(result).toEqual({ allow: true });
    expect(reported).toHaveLength(1);
    expect((reported[0] as { error: unknown }).error).toBe(boom);
  });

  it("is fail-open even without an onError hook wired (silent, not thrown)", async () => {
    const brokenStore: RateLimitStore = {
      take: () => Promise.reject(new Error("boom")),
    };
    const limiter = createRateLimiter(brokenStore, undefined, () => 0);
    await expect(limiter.take({ routeClass: "compose", rule: RULE })).resolves.toEqual({ allow: true });
  });

  it("uses the injected clock, not the real one", async () => {
    let clock = 0;
    const limiter = createRateLimiter(createMemoryRateLimitStore(), undefined, () => clock);
    expect((await limiter.take({ routeClass: "compose", rule: RULE })).allow).toBe(true);
    expect((await limiter.take({ routeClass: "compose", rule: RULE })).allow).toBe(false);
    clock = 1000; // 1 second later per the injected clock -> exactly 1 token refilled
    expect((await limiter.take({ routeClass: "compose", rule: RULE })).allow).toBe(true);
  });
});
