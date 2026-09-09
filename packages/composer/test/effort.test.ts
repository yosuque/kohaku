import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposePolicy, compose } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

/** A minimal correct L2 output (bridge contract: fetchData → render → ready). */
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

function makeCtx(llm: FakeLlm, policy: ComposePolicy): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

describe("ComposePolicy.effort (per-tier reasoning effort threaded to the LLM request)", () => {
  it("L1: policy.effort.l1 is threaded to generateObject as GenerateObjectRequest.effort", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    await compose(GUI_INPUT, makeCtx(llm, { effort: { l1: "high" } }));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.kind).toBe("object");
    expect(llm.calls[0]!.effort).toBe("high");
  });

  it("L1: an unset policy.effort.l1 sends no effort at all (undefined, not a default value)", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    await compose(GUI_INPUT, makeCtx(llm, {}));
    expect(llm.calls[0]!.effort).toBeUndefined();
  });

  it("L1: effort.l2 alone (l1 unset) does not affect the L1 call", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    await compose(GUI_INPUT, makeCtx(llm, { effort: { l2: "max" } }));
    expect(llm.calls[0]!.effort).toBeUndefined();
  });

  it("L2: policy.effort.l2 is threaded to generateText as GenerateTextRequest.effort", async () => {
    const llm = new FakeLlm({ texts: [GOOD_HTML] });
    await compose(GUI_INPUT, makeCtx(llm, { allowL2: true, routeTier: () => "L2", effort: { l2: "low" } }));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.kind).toBe("text");
    expect(llm.calls[0]!.effort).toBe("low");
  });

  it("L2: effort.l1 alone (l2 unset) does not affect the L2 call", async () => {
    const llm = new FakeLlm({ texts: [GOOD_HTML] });
    await compose(GUI_INPUT, makeCtx(llm, { allowL2: true, routeTier: () => "L2", effort: { l1: "max" } }));
    expect(llm.calls[0]!.effort).toBeUndefined();
  });

  it("L1 and L2 can carry independent effort levels within the same policy", async () => {
    const l1Llm = new FakeLlm({ objects: [goodRawDraft()] });
    await compose(GUI_INPUT, makeCtx(l1Llm, { effort: { l1: "low", l2: "max" } }));
    expect(l1Llm.calls[0]!.effort).toBe("low");

    const l2Llm = new FakeLlm({ texts: [GOOD_HTML] });
    await compose(
      GUI_INPUT,
      makeCtx(l2Llm, {
        allowL2: true,
        routeTier: () => "L2",
        effort: { l1: "low", l2: "max" },
      }),
    );
    expect(l2Llm.calls[0]!.effort).toBe("max");
  });
});
