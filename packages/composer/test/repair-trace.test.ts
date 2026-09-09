import type { LlmPort } from "@kohaku-ui/llm";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposeErrorContext, compose } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

/**
 * Characterization tests for the L1/L2 repair loop, written BEFORE the Form Template Method refactor
 * (tiers/shared.ts's runRepairLoop) that unifies l1-generate.ts and l2-generate.ts. These pin the exact
 * shape of trace.attempts (kind / ok / issues / usage presence) and the observer.onError context for a
 * representative set of paths, so that the refactor can be verified to be behavior-preserving by rerunning
 * this file and confirming the inline snapshots still match.
 */

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

/** empty components = catalog/structural-validation failure (repair-target "invalid", same fixture as budget.test.ts) */
const BAD = { components: [], events: [] };

/** A minimal correct output compliant with the L2 bridge contract (fetchData → render → ready). */
const GOOD_HTML = [
  '<!DOCTYPE html><html><head><title>Sales widget</title></head><body><div id="app"></div><script>',
  "async function main() {",
  '  const data = await window.kohaku.fetchData("query://sales/summary?fy=2026&groupBy=region&q=3");',
  '  document.getElementById("app").textContent = JSON.stringify(data.rows);',
  "  window.kohaku.ready();",
  "}",
  "main();",
  "</script></body></html>",
].join("\n");

/** A hallucinated API observed in the field: window.kohaku.onReady (runtime TypeError → cause of boot timeout). */
const HALLUCINATED_HTML =
  "<!DOCTYPE html><html><body><script>window.kohaku.onReady(function () { window.kohaku.ready(); });</script></body></html>";

/** Reduces an onError capture to the fields this file cares about pinning (phase / tier / budgetExceeded / reason shape). */
function pickErrorCtx(ctx: ComposeErrorContext) {
  return {
    phase: ctx.phase,
    tier: ctx.tier,
    budgetExceeded: ctx.budgetExceeded ?? false,
    hasReason: ctx.reason != null,
  };
}

describe("repair loop trace characterization (pre-refactor pin)", () => {
  it("(1) L1 invalid output: repair succeeds on attempt 2", async () => {
    const llm = new FakeLlm({ objects: [BAD, goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(spec.provenance.tier).toBe("L1");
    expect(trace.attempts).toMatchInlineSnapshot(`
      [
        {
          "issues": [
            "components is empty",
          ],
          "kind": "l1",
          "ok": false,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
          },
        },
        {
          "kind": "l1",
          "ok": true,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
          },
        },
      ]
    `);
  });

  it("(2) L1 abort (ABORTED): no repair, single attempt, falls back cancelled (not a transient generation failure) — attempts + onError pinned", async () => {
    const llm = new FakeLlm({
      objects: () => {
        throw new LlmError("ABORTED", "timeout(test)");
      },
    });
    const captured: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      ...makeCtx(llm, { allowL2: true }),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(trace.cancelled).toBe(true);
    expect(trace.attempts).toMatchInlineSnapshot(`
      [
        {
          "issues": [
            "timeout(test)",
          ],
          "kind": "l1",
          "ok": false,
        },
      ]
    `);
    expect(captured).toHaveLength(1);
    expect(pickErrorCtx(captured[0]!)).toMatchInlineSnapshot(`
      {
        "budgetExceeded": false,
        "hasReason": true,
        "phase": "cancelled",
        "tier": "L1",
      }
    `);
  });

  it("(2b) L1 transient failure (PROVIDER): same discrimination as ABORTED — attempts pinned", async () => {
    const llm: LlmPort = {
      provider: "throwing",
      modelId: "throwing-model",
      async generateObject() {
        throw new LlmError("PROVIDER", "provider down(test)");
      },
      async generateText() {
        throw new Error("throwing stub: generateText not supported");
      },
    };
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, { allowL2: true }));

    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(trace.attempts).toMatchInlineSnapshot(`
      [
        {
          "issues": [
            "provider down(test)",
          ],
          "kind": "l1",
          "ok": false,
        },
      ]
    `);
  });

  it("(3) L2 lint failure (route=L2): repair attempt succeeds on attempt 2", async () => {
    const llm = new FakeLlm({ texts: [HALLUCINATED_HTML, GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(spec.provenance.tier).toBe("L2");
    expect(trace.attempts).toMatchInlineSnapshot(`
      [
        {
          "issues": [
            "L2_UNKNOWN_API: window.kohaku.onReady does not exist (it will throw a TypeError at runtime). The only available APIs are fetchData / emit / onProps / ready. Remove every occurrence of kohaku.onReady, including comments",
          ],
          "kind": "l2",
          "ok": false,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
          },
        },
        {
          "kind": "l2",
          "ok": true,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
          },
        },
      ]
    `);
  });

  it("(4a) budget skip at L1 attempt 0: zero-budget immediate fallback, no LLM call — attempts + onError pinned", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const captured: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      ...makeCtx(llm, { budget: { perCompose: { stopAfterTokens: 0 } } }),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(llm.calls).toHaveLength(0);
    expect(trace.attempts).toMatchInlineSnapshot(`[]`);
    expect(captured).toHaveLength(1);
    expect(pickErrorCtx(captured[0]!)).toMatchInlineSnapshot(`
      {
        "budgetExceeded": true,
        "hasReason": true,
        "phase": "fallback",
        "tier": "L1",
      }
    `);
  });

  it("(4b) budget skip at an L2 repair attempt: initial L2 lint fails, repair skipped by budget — attempts + onError pinned", async () => {
    let checkCalls = 0;
    const check = () => {
      checkCalls += 1;
      // 1st call: the pre-L2 budget check (before generateL2 starts) — allow.
      // 2nd call: the pre-repair budget check inside generateL2 (attempt 1) — deny.
      return checkCalls <= 1 ? { allow: true } : { allow: false, reason: "L2 repair budget exceeded(test)" };
    };
    const llm = new FakeLlm({ texts: [HALLUCINATED_HTML, GOOD_HTML] });
    const captured: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      ...makeCtx(llm, { allowL2: true, routeTier: () => "L2", budget: { check } }),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(spec.provenance.fallback?.from).toBe("L2");
    expect(llm.calls).toHaveLength(1);
    expect(trace.attempts).toMatchInlineSnapshot(`
      [
        {
          "issues": [
            "L2_UNKNOWN_API: window.kohaku.onReady does not exist (it will throw a TypeError at runtime). The only available APIs are fetchData / emit / onProps / ready. Remove every occurrence of kohaku.onReady, including comments",
          ],
          "kind": "l2",
          "ok": false,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
          },
        },
      ]
    `);
    expect(captured).toHaveLength(1);
    expect(pickErrorCtx(captured[0]!)).toMatchInlineSnapshot(`
      {
        "budgetExceeded": true,
        "hasReason": true,
        "phase": "fallback",
        "tier": "L2",
      }
    `);
  });
});
