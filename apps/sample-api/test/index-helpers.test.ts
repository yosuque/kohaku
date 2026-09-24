import { describe, expect, it } from "vitest";
import { schemaSuggestEnabled, schemaSuggestTimeoutMs, shutdownPrestopMs } from "../src/index.js";

// index.ts guards its own `main()` (env loading, a real LLM, the network listener, process.once) behind an
// `isMain` check (mirrors sample-mcp's src/http.ts), so importing it here for these pure/exported helpers
// has no side effects. The shared graceful-shutdown machinery (shutdownGraceMs / createGracefulShutdownHandler)
// moved to src/app/shutdown.ts and is covered by test/shutdown-handler.test.ts; shutdownPrestopMs stays here
// (only sample-api's REST entry point has a readiness endpoint worth a pre-stop wait).

describe("shutdownPrestopMs (env parsing)", () => {
  it("defaults when unset", () => {
    expect(shutdownPrestopMs({})).toBe(0);
  });
  it("parses a valid override", () => {
    expect(shutdownPrestopMs({ KOHAKU_SHUTDOWN_PRESTOP_MS: "250" })).toBe(250);
  });
  it("falls back to 0 for non-numeric / negative values", () => {
    expect(shutdownPrestopMs({ KOHAKU_SHUTDOWN_PRESTOP_MS: "-5" })).toBe(0);
    expect(shutdownPrestopMs({ KOHAKU_SHUTDOWN_PRESTOP_MS: "not-a-number" })).toBe(0);
  });
});

describe("schemaSuggestEnabled / schemaSuggestTimeoutMs (KOHAKU_PROMOTION_SCHEMA_SUGGEST* kill switch)", () => {
  it("is enabled by default (unset)", () => {
    expect(schemaSuggestEnabled({})).toBe(true);
  });
  it("only the literal '0' disables it", () => {
    expect(schemaSuggestEnabled({ KOHAKU_PROMOTION_SCHEMA_SUGGEST: "0" })).toBe(false);
    expect(schemaSuggestEnabled({ KOHAKU_PROMOTION_SCHEMA_SUGGEST: "false" })).toBe(true);
    expect(schemaSuggestEnabled({ KOHAKU_PROMOTION_SCHEMA_SUGGEST: "1" })).toBe(true);
  });
  it("timeout defaults to 20000ms and parses an override", () => {
    expect(schemaSuggestTimeoutMs({})).toBe(20_000);
    expect(schemaSuggestTimeoutMs({ KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(schemaSuggestTimeoutMs({ KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS: "0" })).toBe(20_000);
  });
});
