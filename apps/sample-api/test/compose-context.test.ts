import { describe, expect, it } from "vitest";
import { composeDeadlineMs } from "../src/app/compose-context.js";

// composeDeadlineMs mirrors apps/sample-mcp/src/setup.ts's snapshotTtlMs parsing contract: unset /
// non-numeric / <= 0 all fall back to the default, and a valid positive integer is honored verbatim.
describe("composeDeadlineMs (KOHAKU_COMPOSE_DEADLINE_MS parsing)", () => {
  it("defaults to 240000ms when unset", () => {
    expect(composeDeadlineMs({})).toBe(240_000);
  });

  it("honors a valid positive integer", () => {
    expect(composeDeadlineMs({ KOHAKU_COMPOSE_DEADLINE_MS: "5000" })).toBe(5000);
  });

  it("falls back to the default for non-numeric input", () => {
    expect(composeDeadlineMs({ KOHAKU_COMPOSE_DEADLINE_MS: "not-a-number" })).toBe(240_000);
  });

  it("falls back to the default for zero or negative input", () => {
    expect(composeDeadlineMs({ KOHAKU_COMPOSE_DEADLINE_MS: "0" })).toBe(240_000);
    expect(composeDeadlineMs({ KOHAKU_COMPOSE_DEADLINE_MS: "-100" })).toBe(240_000);
  });
});
