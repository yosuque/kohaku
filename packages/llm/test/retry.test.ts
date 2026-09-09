import { describe, expect, it } from "vitest";
import {
  isRetryableProviderError,
  nextDelayMs,
  type RetryDeps,
  retryableProviderError,
  withProviderRetry,
} from "../src/adapters/retry.js";
import type { RetryPolicy } from "../src/env.js";

const POLICY: RetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 250,
  backoffFactor: 2,
  jitter: 0.25,
};

/** An Error mimicking the AI SDK's APICallError (satisfying the structural-detection conditions). */
function apiError(opts: {
  isRetryable: boolean;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
}): Error {
  return Object.assign(new Error(`api ${opts.statusCode ?? ""}`), {
    name: "AI_APICallError",
    url: "https://example/api",
    responseHeaders: opts.responseHeaders ?? {},
    statusCode: opts.statusCode ?? 500,
    isRetryable: opts.isRetryable,
  });
}

/** Injected deps that record waits and resolve immediately (clock advances by the wait amount). random=0.5 gives jitter 0 (center value). */
function makeDeps(): { sleeps: number[]; deps: RetryDeps; clock: () => number } {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: () => clock,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      random: () => 0.5,
    },
  };
}

const freshSignal = (): AbortSignal => new AbortController().signal;

describe("withProviderRetry", () => {
  it("PROVIDER fails twice → succeeds on the 3rd (backoff 250ms → 500ms)", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      if (calls <= 2) throw apiError({ isRetryable: true });
      return "ok";
    };
    const { sleeps, deps } = makeDeps();
    const r = await withProviderRetry(fn, {
      policy: POLICY,
      signal: freshSignal(),
      deadline: 1_000_000,
      deps,
    });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    // random=0.5 gives jitter 0, so base only: 250, 250*2=500.
    expect(sleeps).toEqual([250, 500]);
  });

  it("ABORTED (AbortError) propagates immediately without retrying", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const { sleeps, deps } = makeDeps();
    await expect(
      withProviderRetry(fn, { policy: POLICY, signal: freshSignal(), deadline: 1_000_000, deps }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("propagates immediately even for a retryable PROVIDER if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      throw apiError({ isRetryable: true });
    };
    const { sleeps, deps } = makeDeps();
    await expect(
      withProviderRetry(fn, {
        policy: POLICY,
        signal: controller.signal,
        deadline: 1_000_000,
        deps,
      }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("aborts when the wait would cross timeoutMs (deadline)", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      throw apiError({ isRetryable: true });
    };
    const { sleeps, deps } = makeDeps();
    // clock=0, and the first backoff 250ms crosses deadline 100, so it gives up without waiting.
    await expect(
      withProviderRetry(fn, { policy: POLICY, signal: freshSignal(), deadline: 100, deps }),
    ).rejects.toMatchObject({ isRetryable: true });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("gives up after 1 attempt when maxRetries=0", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      throw apiError({ isRetryable: true });
    };
    const { sleeps, deps } = makeDeps();
    await expect(
      withProviderRetry(fn, {
        policy: { ...POLICY, maxRetries: 0 },
        signal: freshSignal(),
        deadline: 1_000_000,
        deps,
      }),
    ).rejects.toMatchObject({ isRetryable: true });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("a non-retryable PROVIDER (isRetryable=false, e.g. structured 400) propagates immediately", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      throw apiError({ isRetryable: false, statusCode: 400 });
    };
    const { sleeps, deps } = makeDeps();
    await expect(
      withProviderRetry(fn, { policy: POLICY, signal: freshSignal(), deadline: 1_000_000, deps }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("honors Retry-After and prioritizes it over backoff", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw apiError({ isRetryable: true, responseHeaders: { "retry-after": "2" } });
      return "ok";
    };
    const { sleeps, deps } = makeDeps();
    const r = await withProviderRetry(fn, {
      policy: POLICY,
      signal: freshSignal(),
      deadline: 1_000_000,
      deps,
    });
    expect(r).toBe("ok");
    // retry-after: 2 seconds = 2000ms (not the exponential backoff 250).
    expect(sleeps).toEqual([2000]);
  });
});

describe("retryableProviderError / isRetryableProviderError", () => {
  it("a retryable PROVIDER returns null with no header (=retryable, wait left to backoff)", () => {
    expect(retryableProviderError(apiError({ isRetryable: true }))).toBeNull();
    expect(isRetryableProviderError(apiError({ isRetryable: true }))).toBe(true);
  });

  it("the retry-after-ms header is returned as milliseconds", () => {
    const err = apiError({ isRetryable: true, responseHeaders: { "retry-after-ms": "1500" } });
    expect(retryableProviderError(err)).toBe(1500);
  });

  it("a non-retryable PROVIDER / non-APICallError is undefined (=out of scope)", () => {
    expect(retryableProviderError(apiError({ isRetryable: false }))).toBeUndefined();
    expect(retryableProviderError(new Error("plain"))).toBeUndefined();
    expect(isRetryableProviderError(apiError({ isRetryable: false }))).toBe(false);
    expect(isRetryableProviderError(new Error("plain"))).toBe(false);
  });

  it("detects an APICallError buried in the cause chain", () => {
    const wrapped = Object.assign(new Error("wrapper"), {
      cause: apiError({ isRetryable: true }),
    });
    expect(isRetryableProviderError(wrapped)).toBe(true);
  });
});

describe("nextDelayMs", () => {
  it("stays within the ±jitter range (endpoints at random 0/1)", () => {
    // attempt 0: base=250, jitter=0.25 → [187.5, 312.5]
    expect(nextDelayMs(POLICY, 0, null, () => 0)).toBe(188); // 250*(1-0.25)=187.5 → round 188
    expect(nextDelayMs(POLICY, 0, null, () => 0.5)).toBe(250); // center
    expect(nextDelayMs(POLICY, 0, null, () => 1)).toBe(313); // 250*(1+0.25)=312.5 → round 313
    // attempt 1: base=500
    expect(nextDelayMs(POLICY, 1, null, () => 0.5)).toBe(500);
  });

  it("prioritizes Retry-After over the backoff calculation when present", () => {
    expect(nextDelayMs(POLICY, 3, 1234, () => 0.5)).toBe(1234);
  });
});
