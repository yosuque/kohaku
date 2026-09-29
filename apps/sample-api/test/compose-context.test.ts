import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { SemanticPort, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { composeDeadlineMs, createComposeContext, sharedComposePolicy } from "../src/app/compose-context.js";
import type { PromotedRegistry } from "../src/intents/promoted-registry.js";

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

describe("createComposeContext: per-language policy overrides", () => {
  function makeContext() {
    return createComposeContext({
      // policyFor never touches the registry / semantic port / storage; only the catalog getters would.
      registry: {} as PromotedRegistry,
      semantic: {} as SemanticPort,
      storage: {} as StoragePort,
      llm: new FakeLlm({ objects: [] }),
      shared: sharedComposePolicy(),
    });
  }

  it("builds each language's few-shot / fixed-spec overrides once, not once per request", () => {
    const ctx = makeContext();
    const first = ctx.policyFor?.({ surface: "web", locale: "en" });
    const second = ctx.policyFor?.({ surface: "web", locale: "en" });
    expect(second?.fewShot).toBeDefined();
    expect(second?.fewShot).toBe(first?.fewShot);
    expect(second?.fixedSpecs).toBe(first?.fixedSpecs);

    const ja1 = ctx.policyFor?.({ surface: "web", locale: "ja" });
    const ja2 = ctx.policyFor?.({ surface: "web", locale: "ja-JP" });
    expect(ja1?.fixedSpecs).toBeDefined();
    expect(ja2?.fixedSpecs).toBe(ja1?.fixedSpecs);
    expect(ja1?.fixedSpecs).not.toBe(first?.fixedSpecs);
    expect(ja1?.fewShot).toBeUndefined(); // JA omits few-shot by design
  });
});
