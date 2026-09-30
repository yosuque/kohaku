import { BindingError, createBindingClient } from "@kohaku-ui/data-binding";
import { describe, expect, it } from "vitest";
import { actionRateLimitedError, resolveFailureResponse } from "../src/boot/tool-errors.js";

/** The structuredContent host-mcp-apps' rate-limit tool error carries (SPEC §6.1, REST-RL-001's MCP counterpart). */
const RATE_LIMITED = {
  error: { code: "RATE_LIMITED", message: "rate limit exceeded", retryAfterMs: 1500 },
};

describe("resolveFailureResponse (kohaku_resolve_binding tool error -> fetcher response)", () => {
  it("a structured RATE_LIMITED reaches the binding client as a RATE_LIMITED BindingError with retryAfterMs", async () => {
    const client = createBindingClient({
      capability: "cap:x",
      fetcher: async () => resolveFailureResponse(RATE_LIMITED),
    });
    const err = await client.resolve("query://sales/trend").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BindingError);
    expect(err).toMatchObject({ code: "RATE_LIMITED", status: 429, retryAfterMs: 1500 });
  });

  it("a RATE_LIMITED without retryAfterMs still maps to RATE_LIMITED, just without a hint", async () => {
    const client = createBindingClient({
      capability: "cap:x",
      fetcher: async () => resolveFailureResponse({ error: { code: "RATE_LIMITED" } }),
    });
    const err = (await client.resolve("query://sales/trend").catch((e: unknown) => e)) as BindingError;
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it.each([
    ["no structured content", undefined],
    ["another error code", { error: { code: "FORBIDDEN" } }],
  ])("%s stays a plain 403", (_label, structured) => {
    expect(resolveFailureResponse(structured)).toEqual({ status: 403, body: null });
  });
});

describe("actionRateLimitedError (kohaku_action tool error -> BindingError)", () => {
  it("carries retryAfterMs on a RATE_LIMITED BindingError", () => {
    const err = actionRateLimitedError(RATE_LIMITED);
    expect(err).toBeInstanceOf(BindingError);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 1500, message: "rate limit exceeded" });
  });

  it("is null for any other failure (the caller keeps its plain Error)", () => {
    expect(actionRateLimitedError(undefined)).toBeNull();
    expect(actionRateLimitedError({ error: { code: "ACTION_PARAMS_INVALID" } })).toBeNull();
  });
});
