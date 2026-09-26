import { describe, expect, it } from "vitest";
import { errorBody } from "../src/errors.js";

// Structural half of REST-RL-001 (SPEC §6.1): the wire shape a rate-limited response uses. The
// enforcement half (actually deciding a request is over budget and returning 429) is exercised by the
// rate-limiter middleware tests once wired (see the policy-runtime/rate-limit tasks); this file pins
// only that the envelope carries RATE_LIMITED + retryAfterMs when the caller supplies one.
describe("errorBody(RATE_LIMITED)", () => {
  it("carries retryAfterMs when given", () => {
    expect(errorBody("RATE_LIMITED", "rate limit exceeded", undefined, 1500)).toEqual({
      error: { code: "RATE_LIMITED", message: "rate limit exceeded", retryAfterMs: 1500 },
    });
  });

  it("omits retryAfterMs when not given (unchanged shape for every other code)", () => {
    expect(errorBody("RATE_LIMITED", "rate limit exceeded")).toEqual({
      error: { code: "RATE_LIMITED", message: "rate limit exceeded" },
    });
  });

  it("carries both requestId and retryAfterMs together", () => {
    expect(errorBody("RATE_LIMITED", "rate limit exceeded", "req-1", 2000)).toEqual({
      error: { code: "RATE_LIMITED", message: "rate limit exceeded", requestId: "req-1", retryAfterMs: 2000 },
    });
  });
});
