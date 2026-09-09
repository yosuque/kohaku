import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage, REF } from "./helpers.js";

const INTENT_INPUT = {
  kind: "intent" as const,
  intent: {
    canonical: "sales.quarterly_summary",
    params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
};

/** An LlmPort stub that captures generateObject's generation schema (jsonSchema). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capturingLlm(response: unknown): { llm: LlmPort; captured: { jsonSchema: any }[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured: { jsonSchema: any }[] = [];
  const llm: LlmPort = {
    provider: "fake",
    modelId: "fake-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      captured.push({ jsonSchema: (req.schema as { jsonSchema: unknown }).jsonSchema });
      return { object: response as T, usage: { inputTokens: 0, outputTokens: 0 }, model: "fake-model" };
    },
    async generateText() {
      throw new Error("unused");
    },
  };
  return { llm, captured };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dataRefSchemas(jsonSchema: any): any[] {
  // Every variant's `data` field (directly, or wrapped in `anyOf: [refSchema, {type:"null"}]` for optional
  // data) — collect every `properties.$ref` schema found anywhere in the generation schema, regardless of
  // which shape it is wrapped in, so this test does not need to track buildGenerationSchema's exact layout.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found: any[] = [];
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj["$ref"] != null && typeof obj["$ref"] === "object") found.push(obj["$ref"]);
    for (const value of Object.values(obj)) visit(value);
  };
  visit(jsonSchema);
  return found;
}

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"]): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

describe("ComposePolicy.refConstraint", () => {
  it('default ("schema", unset): the generation schema pins data.$ref to an enum of the resolved reference set', async () => {
    const { llm, captured } = capturingLlm(goodRawDraft(REF));
    await compose(INTENT_INPUT, makeCtx(llm, {}));
    const refSchemas = dataRefSchemas(captured.at(-1)!.jsonSchema);
    expect(refSchemas.length).toBeGreaterThan(0);
    for (const s of refSchemas) {
      expect(s).toEqual({ type: "string", enum: [REF] });
    }
  });

  it('"validate": the generation schema relaxes data.$ref to a plain string (no enum) — the grammar no longer depends on the resolved reference set', async () => {
    const { llm, captured } = capturingLlm(goodRawDraft(REF));
    await compose(INTENT_INPUT, makeCtx(llm, { refConstraint: "validate" }));
    const refSchemas = dataRefSchemas(captured.at(-1)!.jsonSchema);
    expect(refSchemas.length).toBeGreaterThan(0);
    for (const s of refSchemas) {
      expect(s).toEqual({ type: "string" });
    }
  });

  it('"validate": an out-of-set $ref is sent back with the DATA_REF_UNRESOLVED code (not INVALID_REF), and repair still succeeds', async () => {
    const evil = "query://sales/evil?fy=2026&groupBy=region";
    const llm = new FakeLlm({ objects: [goodRawDraft(evil), goodRawDraft()] });
    const { spec, trace } = await compose(INTENT_INPUT, makeCtx(llm, { refConstraint: "validate" }));

    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[0]!.issues!.join(" ")).toContain("DATA_REF_UNRESOLVED");
    expect(trace.attempts[0]!.issues!.join(" ")).not.toContain("INVALID_REF");
    expect(trace.attempts[0]!.issues!.join(" ")).toContain(evil);
    expect(trace.attempts[1]!.ok).toBe(true);
    for (const c of spec.components) {
      if (c.data != null) expect(c.data.$ref).toBe(REF);
    }
  });

  it('default ("schema", unset): an out-of-set $ref still uses the pre-existing INVALID_REF code (unchanged default behavior)', async () => {
    const evil = "query://sales/evil?fy=2026&groupBy=region";
    const llm = new FakeLlm({ objects: [goodRawDraft(evil), goodRawDraft()] });
    const { trace } = await compose(INTENT_INPUT, makeCtx(llm, {}));
    expect(trace.attempts[0]!.issues!.join(" ")).toContain("INVALID_REF");
    expect(trace.attempts[0]!.issues!.join(" ")).not.toContain("DATA_REF_UNRESOLVED");
  });

  it('"validate": when every attempt (initial + every repair) returns an out-of-set $ref, repair is exhausted and compose falls back deterministically, with every attempt\'s issues identifying the unresolved-reference cause', async () => {
    const evil = "query://sales/evil?fy=2026&groupBy=region";
    // Default maxRepairAttempts=1 => 2 total attempts (initial + 1 repair). Both return the same
    // out-of-set ref, so neither attempt can ever validate — unlike the existing "repair succeeds on the
    // 2nd attempt" test above, this exhausts the repair loop entirely.
    const llm = new FakeLlm({ objects: [goodRawDraft(evil), goodRawDraft(evil)] });
    const { spec, trace } = await compose(INTENT_INPUT, makeCtx(llm, { refConstraint: "validate" }));

    // allowL2 defaults to false, so an exhausted "invalid" L1 failure settles as a deterministic fallback
    // rather than promoting to L2 (see tier-ladder.ts's settleL1Failure).
    expect(trace.tier).toBe("L1");
    expect(trace.fallback).toBeDefined();
    expect(spec.provenance.fallback).toBeDefined();

    // Every attempt was exhausted (none ok), and each one's issues name the unresolved-reference cause —
    // the DATA_REF_UNRESOLVED code (not INVALID_REF, since refConstraint is "validate") together with the
    // actual out-of-set URI — so the cause of the fallback is identifiable from the trace even though the
    // top-level fallback.reason string itself is a generic, cause-agnostic message.
    expect(trace.attempts).toHaveLength(2);
    for (const attempt of trace.attempts) {
      expect(attempt.ok).toBe(false);
      const issues = attempt.issues!.join(" ");
      expect(issues).toContain("DATA_REF_UNRESOLVED");
      expect(issues).not.toContain("INVALID_REF");
      expect(issues).toContain(evil);
    }
  });
});
