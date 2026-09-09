import { describe, expect, it } from "vitest";
import { tallyUsage } from "../src/promotion/usage.js";

// Unit tests for tallyUsage's telemetry exclusion and sessions fallback.

describe("tallyUsage (uses / sessions aggregation of component.used)", () => {
  it("used with source:telemetry is excluded from uses / sessions", () => {
    const result = tallyUsage([
      { payload: { source: "telemetry", sessionId: "s-tele" } },
      { payload: { source: "telemetry" } },
    ]);
    expect(result).toEqual({ uses: 0, sessions: 0 });
  });

  it("only non-telemetry used are counted toward uses / sessions", () => {
    const result = tallyUsage([
      { payload: { sessionId: "s-a" } },
      { payload: { source: "compose", sessionId: "s-b" } },
      { payload: { source: "telemetry", sessionId: "s-tele" } },
      { payload: { sessionId: "s-a" } },
    ]);
    expect(result.uses).toBe(3);
    expect(result.sessions).toBe(2);
  });

  it("sessions falls back to 1 when there is counted usage even without a sessionId", () => {
    const result = tallyUsage([{ payload: { artifactId: "art-1" } }, { payload: {} }]);
    expect(result).toEqual({ uses: 2, sessions: 1 });
  });
});
