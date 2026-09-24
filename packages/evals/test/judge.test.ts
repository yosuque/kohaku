import { FakeLlm } from "@kohaku-ui/llm/fake";
import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import {
  type ColumnMeta,
  createJudge,
  type JudgeSpecInput,
  l1QualityRubric,
  l2PromotionRubric,
  l2PromotionRubricV0_1,
  l2PromotionRubricV0_2,
  l2PromotionRubricV0_3,
  type Rubric,
  runQuality,
} from "../src/index.js";

/** Builds a judge response (conforming to JudgeOutputSchema) that assigns a uniform score to each rubric criterion. */
function uniformVerdict(rubric: Rubric, score: number, summary = "scoring") {
  return {
    criteria: rubric.criteria.map((c) => ({ id: c.id, score, reasoning: `${c.id}=${score}` })),
    summary,
  };
}

const L1_SPEC: UISpec = parseSpec(fixture);
const COLUMNS: ColumnMeta[] = [
  { name: "region", type: "string", description: "Region" },
  { name: "revenue", type: "number", description: "Sales" },
];

function specInput(spec: UISpec = L1_SPEC): JudgeSpecInput {
  return {
    kind: "l1-spec",
    intent: { canonical: "sales.quarterly_summary", params: { fiscalYear: 2026, quarter: 3 } },
    spec,
    columns: COLUMNS,
  };
}

describe("createJudge: L2 promotion review (judge)", () => {
  it("combines with a weighted average and stamps the rubric id/version into the verdict", async () => {
    const llm = new FakeLlm({ objects: [uniformVerdict(l2PromotionRubric, 0.8, "worthy of promotion")] });
    const judge = createJudge({ llm, passScore: 0.5 });
    const verdict = await judge.judge({
      kind: "l2-component",
      html: "<html><body><script>window.kohaku.ready()</script></body></html>",
      request: "as a heatmap",
      usage: { uses: 3, sessions: 2 },
      // A draft is supplied so this exercises the "full" rubric (all 7 criteria, including
      // suggestion_fidelity) — see the "rubric variant selection" describe block below for the
      // no-draft/no-suggestion ("no-schema") behavior.
      draft: { componentType: "sales.calendarHeatmap", intentName: "sales.calendar_heatmap" },
    });
    // All criteria 0.8 and weights sum to 1.0, so the combined score is also 0.8. safety's floor is 0.5,
    // and 0.8 clears it, so nothing is vetoed.
    expect(verdict.score).toBe(0.8);
    expect(verdict.pass).toBe(true);
    expect(verdict.vetoedBy).toEqual([]);
    expect(verdict.rubricId).toBe("l2-promotion");
    expect(verdict.rubricVersion).toBe("0.4");
    expect(verdict.summary).toBe("worthy of promotion");
  });

  it("rubric 0.4 carries suggestion_fidelity with weights still summing to 1.0", () => {
    expect(l2PromotionRubric.version).toBe("0.4");
    const ids = l2PromotionRubric.criteria.map((c) => c.id);
    expect(ids).toContain("suggestion_fidelity");
    expect(ids).toContain("schema_inferability");
    const sum = l2PromotionRubric.criteria.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("copies a supplied schema suggestion into the prompt as untrusted evidence (absent when unspecified)", async () => {
    const llm = new FakeLlm({
      objects: [uniformVerdict(l2PromotionRubric, 0.7), uniformVerdict(l2PromotionRubric, 0.7)],
    });
    const judge = createJudge({ llm, passScore: 0.5 });
    const base = {
      kind: "l2-component" as const,
      html: "<html><body><script>window.kohaku.ready()</script></body></html>",
      request: "as a heatmap",
      usage: { uses: 3, sessions: 2 },
    };
    await judge.judge({
      ...base,
      suggestion: {
        componentType: "sales.calendarHeatmap",
        intentName: "sales.calendar_heatmap",
        description: "Monthly heatmap",
        paramsJsonSchema: { type: "object", properties: {} },
        events: [{ name: "cellSelected", description: "clicked" }],
      },
    });
    await judge.judge(base);
    expect(llm.calls[0]!.prompt).toContain(
      "## Proposed schema (machine-extracted; verify it against the HTML)",
    );
    expect(llm.calls[0]!.prompt).toContain("sales.calendarHeatmap");
    expect(llm.calls[0]!.prompt).toContain("<<<BEGIN SUGGESTION");
    expect(llm.calls[1]!.prompt).not.toContain("## Proposed schema");
  });

  it("passing telemetry copies real-render observations into the prompt (absent when unspecified)", async () => {
    const llm = new FakeLlm({
      objects: [uniformVerdict(l2PromotionRubric, 0.7), uniformVerdict(l2PromotionRubric, 0.7)],
    });
    const judge = createJudge({ llm, passScore: 0.5 });

    await judge.judge({
      kind: "l2-component",
      html: "<html></html>",
      request: "r",
      usage: { uses: 5, sessions: 3 },
      telemetry: { renderedCount: 4, errorCount: 1 },
    });
    const withTelemetry = llm.calls.at(-1)!.prompt;
    expect(withTelemetry).toContain("Runtime telemetry");
    expect(withTelemetry).toContain("rendered=4, errors=1");

    await judge.judge({
      kind: "l2-component",
      html: "<html></html>",
      request: "r",
      usage: { uses: 5, sessions: 3 },
    });
    expect(llm.calls.at(-1)!.prompt).not.toContain("Runtime telemetry");
  });
});

describe("createJudge: L1 quality scoring (judgeSpec)", () => {
  it("scores with l1QualityRubric and copies the Spec summary and column metadata into the prompt", async () => {
    const llm = new FakeLlm({ objects: [uniformVerdict(l1QualityRubric, 0.9, "good L1")] });
    const judge = createJudge({ llm, passScore: 0.6 });
    const verdict = await judge.judgeSpec(specInput());

    expect(verdict.score).toBe(0.9);
    expect(verdict.pass).toBe(true);
    expect(verdict.rubricId).toBe("l1-quality");
    expect(verdict.rubricVersion).toBe("0.1");

    const prompt = llm.calls.at(-1)!.prompt;
    expect(prompt).toContain("Spec under review (summary)");
    expect(prompt).toContain("sales.quarterly_summary");
    // Column metadata is copied in.
    expect(prompt).toContain("region: string");
    expect(prompt).toContain("revenue: number");
    // The Spec summary shows the component type (components are folded down).
    expect(prompt).toContain(L1_SPEC.components[0]!.type);
  });

  it("judge and judgeSpec stamp separate rubric versions (no cross-contamination)", async () => {
    const llm = new FakeLlm({
      objects: [uniformVerdict(l1QualityRubric, 0.8), uniformVerdict(l2PromotionRubric, 0.8)],
    });
    const judge = createJudge({ llm, passScore: 0.5 });
    const l1 = await judge.judgeSpec(specInput());
    const l2 = await judge.judge({
      kind: "l2-component",
      html: "<html></html>",
      request: "r",
      usage: { uses: 1, sessions: 1 },
    });
    expect(l1.rubricId).toBe("l1-quality");
    expect(l2.rubricId).toBe("l2-promotion");
  });
});

describe("createJudge: error cases of missing and unknown criterion", () => {
  it("when the response omits a criterion its score falls back to 0 / reasoning to (not evaluated); missing safety also vetoes the verdict (n-7)", async () => {
    // A response that omits safety (weight 0.25, floor 0.5) and returns full marks for the remaining 5
    // criteria.
    const llm = new FakeLlm({
      objects: [
        {
          criteria: l2PromotionRubric.criteria
            .filter((c) => c.id !== "safety")
            .map((c) => ({ id: c.id, score: 1, reasoning: `${c.id}=1` })),
          summary: "safety not evaluated",
        },
      ],
    });
    const judge = createJudge({ llm, passScore: 0.5 });
    const verdict = await judge.judge({
      kind: "l2-component",
      html: "<html></html>",
      request: "r",
      usage: { uses: 1, sessions: 1 },
    });
    const safety = verdict.criteria.find((c) => c.id === "safety")!;
    expect(safety.score).toBe(0);
    expect(safety.reasoning).toBe("(not evaluated)");
    // The missing criterion (weight 0.25) is combined as 0 points: the remaining 5 criteria are full marks, so the weighted-average score = 1 - 0.25 = 0.75.
    expect(verdict.score).toBe(0.75);
    // n-7: before the safety floor existed, 0.75 >= passScore (0.5) alone made this a passing verdict —
    // exactly the "safety score 0 but other criteria compensate" escape hatch the floor closes. safety's
    // score (0) is strictly below its floor (0.5), so the verdict is now vetoed and does NOT pass, even
    // though the weighted-average score still clears passScore.
    expect(verdict.vetoedBy).toEqual(["safety"]);
    expect(verdict.pass).toBe(false);
  });

  it("unknown criterion ids mixed into the response are ignored and do not affect the score", async () => {
    const llm = new FakeLlm({
      objects: [
        {
          criteria: [
            ...l2PromotionRubric.criteria.map((c) => ({ id: c.id, score: 0.5, reasoning: c.id })),
            { id: "unknown_extra", score: 1, reasoning: "mixed-in unknown criterion" },
          ],
          summary: "has unknown criterion",
        },
      ],
    });
    const judge = createJudge({ llm, passScore: 0.5 });
    const verdict = await judge.judge({
      kind: "l2-component",
      html: "<html></html>",
      request: "r",
      usage: { uses: 1, sessions: 1 },
      // A draft keeps this on the "full" rubric variant (all 7 criteria) so the unknown-extra-id assertion
      // below is exercised against the same criteria set the response was scripted from.
      draft: { componentType: "sales.calendarHeatmap", intentName: "sales.calendar_heatmap" },
    });
    // Only the rubric's criteria are evaluated. Unknown ids do not appear in verdict.criteria.
    expect(verdict.criteria.map((c) => c.id)).toEqual(l2PromotionRubric.criteria.map((c) => c.id));
    // All criteria 0.5, so the combination is also 0.5 (the unknown criterion's full mark 1.0 is ignored).
    expect(verdict.score).toBe(0.5);
    // safety's own score (0.5) equals its floor (0.5) exactly — the floor only vetoes a score strictly
    // below it, so this is not a veto (a mid-scale score should not be indistinguishable from a clear
    // safety violation).
    expect(verdict.vetoedBy).toEqual([]);
    expect(verdict.pass).toBe(true);
  });
});

describe("rubric validation (fail-fast)", () => {
  const emptyLlm = () => new FakeLlm({ objects: [] });
  const base: Rubric = { id: "custom", version: "1", criteria: [{ id: "a", description: "a", weight: 1 }] };

  it("rejects a negative weight at construction time", () => {
    expect(() =>
      createJudge({
        llm: emptyLlm(),
        specRubric: { ...base, criteria: [{ id: "a", description: "a", weight: -1 }] },
      }),
    ).toThrow(/weight/);
  });

  it("rejects NaN / Infinity weight", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createJudge({
          llm: emptyLlm(),
          rubric: { ...base, criteria: [{ id: "a", description: "a", weight: bad }] },
        }),
      ).toThrow(/weight/);
    }
  });

  it("rejects a weight sum of 0 (all criteria 0)", () => {
    expect(() =>
      createJudge({
        llm: emptyLlm(),
        rubric: { ...base, criteria: [{ id: "a", description: "a", weight: 0 }] },
      }),
    ).toThrow(/total weight/);
  });

  it("rejects duplicate criteria ids", () => {
    expect(() =>
      createJudge({
        llm: emptyLlm(),
        rubric: {
          ...base,
          criteria: [
            { id: "a", description: "a", weight: 0.5 },
            { id: "a", description: "a2", weight: 0.5 },
          ],
        },
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects a rubric with empty criteria", () => {
    expect(() => createJudge({ llm: emptyLlm(), rubric: { ...base, criteria: [] } })).toThrow(/criteria/);
  });

  it("the default rubrics (l2/l1) pass validation", () => {
    expect(() => createJudge({ llm: emptyLlm() })).not.toThrow();
  });
});

describe("weight normalization (custom rubric with sum ≠ 1.0)", () => {
  it("keeps the combined score within [0,1]", async () => {
    const custom: Rubric = {
      id: "custom",
      version: "9.9",
      criteria: [
        { id: "a", description: "a", weight: 1.0 },
        { id: "b", description: "b", weight: 1.0 },
      ],
    };
    const llm = new FakeLlm({
      objects: [
        {
          criteria: [
            { id: "a", score: 0.6, reasoning: "a" },
            { id: "b", score: 0.4, reasoning: "b" },
          ],
          summary: "s",
        },
      ],
    });
    const judge = createJudge({ llm, specRubric: custom, passScore: 0.5 });
    const verdict = await judge.judgeSpec(specInput());
    // (0.6*1 + 0.4*1) / 2.0 = 0.5 (without normalization it would be 1.0 and exceed [0,1]).
    expect(verdict.score).toBe(0.5);
    expect(verdict.rubricId).toBe("custom");
    expect(verdict.rubricVersion).toBe("9.9");
  });
});

describe("runQuality: L1 quality regression harness", () => {
  it("gates pass/fail with the minScore floor and returns a deterministic report that runs alongside golden", async () => {
    // Script judgeSpec responses for 2 cases. The first is a high score, the second a low score.
    const llm = new FakeLlm({
      objects: [uniformVerdict(l1QualityRubric, 0.9), uniformVerdict(l1QualityRubric, 0.4)],
    });
    const judge = createJudge({ llm, passScore: 0.6 });
    const report = await runQuality(
      [
        { name: "high", input: specInput(), minScore: 0.8 },
        { name: "low", input: specInput(), minScore: 0.8 },
      ],
      judge,
    );
    expect(report.pass).toBe(false);
    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.score).toBe(0.9);
    expect(report.cases[1]!.pass).toBe(false);
    expect(report.cases[1]!.score).toBe(0.4);
    // The version stamp remains in each case's verdict.
    expect(report.cases[0]!.verdict.rubricVersion).toBe("0.1");
  });

  it("cases without minScore adopt verdict.pass based on the judge's passScore", async () => {
    // passScore 0.6. Without passing minScore: 1st is 0.7 (pass) / 2nd is 0.5 (fail).
    const llm = new FakeLlm({
      objects: [uniformVerdict(l1QualityRubric, 0.7), uniformVerdict(l1QualityRubric, 0.5)],
    });
    const judge = createJudge({ llm, passScore: 0.6 });
    const report = await runQuality(
      [
        { name: "pass-by-verdict", input: specInput() },
        { name: "fail-by-verdict", input: specInput() },
      ],
      judge,
    );
    // No minScore → verdict.pass (score >= passScore) becomes pass directly.
    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.pass).toBe(report.cases[0]!.verdict.pass);
    expect(report.cases[1]!.pass).toBe(false);
    expect(report.cases[1]!.pass).toBe(report.cases[1]!.verdict.pass);
    expect(report.pass).toBe(false);
    // durationMs is measured (not deterministic) but is still typed as a number.
    expect(typeof report.cases[0]!.durationMs).toBe("number");
  });
});

describe("l2PromotionRubric (v0.4, current — pinned criteria id order, weights, and safety's floor)", () => {
  // m-21/Task 8: uniformVerdict(l2PromotionRubric, ...) generates its expectations FROM l2PromotionRubric's
  // own criteria (see the tests above), so a weight/id-order change to the rubric would pass every one of
  // them silently. Pin the shape directly, following the same literal-value style already used for
  // l2PromotionRubricV0_1/l2PromotionRubricV0_2/l2PromotionRubricV0_3 below. m-22 rebalanced
  // generality/visual_quality; n-7 added safety's floor; the schema-suggestion feature added suggestion_fidelity — this test's
  // weights/floor are exactly what a further rebalance must update (and that update is the proof the pin
  // actually bites).
  it("is version 0.4 with 7 criteria (safety/determinism/a11y/schema_inferability/generality/visual_quality/suggestion_fidelity) and weights summing to 1.0", () => {
    expect(l2PromotionRubric.id).toBe("l2-promotion");
    expect(l2PromotionRubric.version).toBe("0.4");
    expect(l2PromotionRubric.criteria.map((c) => c.id)).toEqual([
      "safety",
      "determinism",
      "a11y",
      "schema_inferability",
      "generality",
      "visual_quality",
      "suggestion_fidelity",
    ]);
    expect(l2PromotionRubric.criteria.map((c) => c.weight)).toEqual([0.25, 0.2, 0.15, 0.05, 0.05, 0.2, 0.1]);
    const sum = l2PromotionRubric.criteria.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it("n-7: only safety carries a floor, pinned to 0.5 (suggestion_fidelity has no floor)", () => {
    expect(l2PromotionRubric.criteria.map((c) => c.floor)).toEqual([
      0.5,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("n-6/n-8: visual_quality's description covers loading states, fluid width, and the countable restrained-color wording", () => {
    const visualQuality = l2PromotionRubric.criteria.find((c) => c.id === "visual_quality")!;
    // n-6: previously-unscored brief items now named explicitly.
    expect(visualQuality.description).toContain("loading");
    expect(visualQuality.description).toContain("never use fixed pixel widths — fill the container width");
    // n-8: "restrained color" (2 words, not scorable from markup) replaced by the L2 brief's own
    // countable wording (prompt.ts's L2_SYSTEM_PROMPT design-brief bullet, verbatim).
    expect(visualQuality.description).not.toContain("restrained color");
    expect(visualQuality.description).toContain(
      "use the primary color for one emphasis at most; tone colors only when they carry meaning",
    );
  });
});

describe("l2PromotionRubricV0_1 (pinned pre-visual_quality rubric)", () => {
  it("is version 0.1 with the 5 pre-rebalance criteria and weights summing to 1.0", () => {
    expect(l2PromotionRubricV0_1.id).toBe("l2-promotion");
    expect(l2PromotionRubricV0_1.version).toBe("0.1");
    expect(l2PromotionRubricV0_1.criteria.map((c) => c.id)).toEqual([
      "safety",
      "determinism",
      "a11y",
      "schema_inferability",
      "generality",
    ]);
    expect(l2PromotionRubricV0_1.criteria.map((c) => c.weight)).toEqual([0.3, 0.2, 0.15, 0.2, 0.15]);
    const sum = l2PromotionRubricV0_1.criteria.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it("a caller can pin it via judge()'s rubric option and get rubricVersion 0.1 in the verdict", async () => {
    const llm = new FakeLlm({ objects: [uniformVerdict(l2PromotionRubricV0_1, 0.9)] });
    const judge = createJudge({ llm, passScore: 0.5, rubric: l2PromotionRubricV0_1 });
    const verdict = await judge.judge({
      kind: "l2-component",
      html: "<html><body><script>window.kohaku.ready()</script></body></html>",
      request: "as a table",
      usage: { uses: 1, sessions: 1 },
    });
    expect(verdict.rubricVersion).toBe("0.1");
    expect(verdict.criteria.map((c) => c.id)).toEqual(l2PromotionRubricV0_1.criteria.map((c) => c.id));
  });
});

describe("l2PromotionRubricV0_2 (pinned pre-Task-8 rubric)", () => {
  it("is version 0.2 with the 6 pre-Task-8 criteria, weights summing to 1.0, and no floors", () => {
    expect(l2PromotionRubricV0_2.id).toBe("l2-promotion");
    expect(l2PromotionRubricV0_2.version).toBe("0.2");
    expect(l2PromotionRubricV0_2.criteria.map((c) => c.id)).toEqual([
      "safety",
      "determinism",
      "a11y",
      "schema_inferability",
      "generality",
      "visual_quality",
    ]);
    expect(l2PromotionRubricV0_2.criteria.map((c) => c.weight)).toEqual([0.25, 0.2, 0.15, 0.15, 0.15, 0.1]);
    expect(l2PromotionRubricV0_2.criteria.map((c) => c.floor)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const sum = l2PromotionRubricV0_2.criteria.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it("a caller can pin it via judge()'s rubric option and get rubricVersion 0.2 in the verdict, with no floor veto even at safety=0", async () => {
    const llm = new FakeLlm({
      objects: [
        {
          criteria: l2PromotionRubricV0_2.criteria.map((c) => ({
            id: c.id,
            score: c.id === "safety" ? 0 : 1,
            reasoning: c.id,
          })),
          summary: "pinned v0.2, safety scored 0",
        },
      ],
    });
    const judge = createJudge({ llm, passScore: 0.5, rubric: l2PromotionRubricV0_2 });
    const verdict = await judge.judge({
      kind: "l2-component",
      html: "<html><body><script>window.kohaku.ready()</script></body></html>",
      request: "as a table",
      usage: { uses: 1, sessions: 1 },
    });
    expect(verdict.rubricVersion).toBe("0.2");
    expect(verdict.criteria.map((c) => c.id)).toEqual(l2PromotionRubricV0_2.criteria.map((c) => c.id));
    // Task 8's safety floor lives only on l2PromotionRubricV0_3 and the current l2PromotionRubric (v0.4),
    // not on this pinned pre-Task-8 snapshot — a consumer who pinned v0.2 keeps the exact pre-Task-8
    // behavior, including the pre-n-7 "safety 0, rest full marks still passes" shape.
    expect(verdict.vetoedBy).toEqual([]);
    expect(verdict.pass).toBe(true);
  });
});

describe("l2PromotionRubricV0_3 (pinned pre-Task-5 rubric)", () => {
  it("is version 0.3 with the 6 pre-Task-5 criteria, weights summing to 1.0, and safety's floor", () => {
    expect(l2PromotionRubricV0_3.id).toBe("l2-promotion");
    expect(l2PromotionRubricV0_3.version).toBe("0.3");
    expect(l2PromotionRubricV0_3.criteria.map((c) => c.id)).toEqual([
      "safety",
      "determinism",
      "a11y",
      "schema_inferability",
      "generality",
      "visual_quality",
    ]);
    expect(l2PromotionRubricV0_3.criteria.map((c) => c.weight)).toEqual([0.25, 0.2, 0.15, 0.15, 0.05, 0.2]);
    expect(l2PromotionRubricV0_3.criteria.map((c) => c.floor)).toEqual([
      0.5,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const sum = l2PromotionRubricV0_3.criteria.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it("a caller can pin it via judge()'s rubric option and get rubricVersion 0.3 in the verdict, with no suggestion_fidelity criterion", async () => {
    const llm = new FakeLlm({ objects: [uniformVerdict(l2PromotionRubricV0_3, 0.9)] });
    const judge = createJudge({ llm, passScore: 0.5, rubric: l2PromotionRubricV0_3 });
    const verdict = await judge.judge({
      kind: "l2-component",
      html: "<html><body><script>window.kohaku.ready()</script></body></html>",
      request: "as a table",
      usage: { uses: 1, sessions: 1 },
    });
    expect(verdict.rubricVersion).toBe("0.3");
    expect(verdict.criteria.map((c) => c.id)).toEqual(l2PromotionRubricV0_3.criteria.map((c) => c.id));
    expect(verdict.criteria.map((c) => c.id)).not.toContain("suggestion_fidelity");
  });
});

describe("rubric variant selection (#14): suggestion_fidelity drop and renormalization with no known schema", () => {
  const HTML_INPUT = {
    kind: "l2-component" as const,
    html: "<html></html>",
    request: "r",
    usage: { uses: 1, sessions: 1 },
  };
  // Deliberately non-uniform per-criterion scores, so the two variants would diverge if their weights
  // actually differed (a uniform score would trivially agree regardless of the weight distribution).
  const SCORES: Record<string, number> = {
    safety: 0.9,
    determinism: 0.8,
    a11y: 0.7,
    schema_inferability: 0.6,
    generality: 0.5,
    visual_quality: 0.4,
    suggestion_fidelity: 1,
  };
  function scriptedFor(rubric: Rubric) {
    return {
      criteria: rubric.criteria.map((c) => ({ id: c.id, score: SCORES[c.id]!, reasoning: c.id })),
      summary: "scored",
    };
  }

  it("drops suggestion_fidelity and reports rubricVariant: 'no-schema' when neither draft nor suggestion is given", async () => {
    const llm = new FakeLlm({ objects: [scriptedFor(l2PromotionRubricV0_3)] });
    const judge = createJudge({ llm, passScore: 0.5 });
    const verdict = await judge.judge(HTML_INPUT);
    expect(verdict.criteria.map((c) => c.id)).toEqual(l2PromotionRubricV0_3.criteria.map((c) => c.id));
    expect(verdict.criteria.map((c) => c.id)).not.toContain("suggestion_fidelity");
    expect(verdict.rubricVariant).toBe("no-schema");
    expect(verdict.rubricVersion).toBe("0.3");
  });

  it("keeps suggestion_fidelity and reports rubricVariant: 'full' when a draft is supplied", async () => {
    const llm = new FakeLlm({ objects: [scriptedFor(l2PromotionRubric)] });
    const judge = createJudge({ llm, passScore: 0.5 });
    const verdict = await judge.judge({
      ...HTML_INPUT,
      draft: { componentType: "sales.calendarHeatmap", intentName: "sales.calendar_heatmap" },
    });
    expect(verdict.criteria.map((c) => c.id)).toEqual(l2PromotionRubric.criteria.map((c) => c.id));
    expect(verdict.rubricVariant).toBe("full");
    expect(verdict.rubricVersion).toBe("0.4");
  });

  it("keeps suggestion_fidelity and reports rubricVariant: 'full' when only a suggestion is supplied (pre-existing behavior)", async () => {
    const llm = new FakeLlm({ objects: [scriptedFor(l2PromotionRubric)] });
    const judge = createJudge({ llm, passScore: 0.5 });
    const verdict = await judge.judge({
      ...HTML_INPUT,
      suggestion: {
        componentType: "sales.calendarHeatmap",
        intentName: "sales.calendar_heatmap",
        description: "d",
        events: [],
      },
    });
    expect(verdict.rubricVariant).toBe("full");
    expect(verdict.rubricVersion).toBe("0.4");
  });

  it("both variants' weights sum to 1", () => {
    expect(l2PromotionRubric.criteria.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1);
    expect(l2PromotionRubricV0_3.criteria.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1);
  });

  it("a no-suggestion input scores identically to explicitly pinning rubric 0.3, given the same per-criterion scores", async () => {
    const autoJudge = createJudge({
      llm: new FakeLlm({ objects: [scriptedFor(l2PromotionRubricV0_3)] }),
      passScore: 0.5,
    });
    const autoVariant = await autoJudge.judge(HTML_INPUT);

    const pinnedJudge = createJudge({
      llm: new FakeLlm({ objects: [scriptedFor(l2PromotionRubricV0_3)] }),
      passScore: 0.5,
      rubric: l2PromotionRubricV0_3,
    });
    const pinned = await pinnedJudge.judge(HTML_INPUT);

    expect(autoVariant.score).toBe(pinned.score);
    expect(autoVariant.pass).toBe(pinned.pass);
    expect(autoVariant.vetoedBy).toEqual(pinned.vetoedBy);
    expect(autoVariant.criteria).toEqual(pinned.criteria);
    // The only observable difference is the additive rubricVariant stamp: it is present (as "no-schema") only
    // when the default rubric's own suggestion_fidelity criterion was actually dropped to get here, not when
    // rubric 0.3 (which never had the criterion) was pinned explicitly.
    expect(autoVariant.rubricVariant).toBe("no-schema");
    expect(pinned.rubricVariant).toBeUndefined();
  });

  it("shows the draft as the schema-fidelity verification target and the suggestion as context-only when both are present", async () => {
    const llm = new FakeLlm({ objects: [scriptedFor(l2PromotionRubric)] });
    const judge = createJudge({ llm, passScore: 0.5 });
    await judge.judge({
      ...HTML_INPUT,
      draft: { componentType: "sales.calendarHeatmap", intentName: "sales.calendar_heatmap" },
      suggestion: {
        componentType: "sales.oldSuggestion",
        intentName: "sales.old_suggestion",
        description: "d",
        events: [],
      },
    });
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain("## Schema being registered (verify this against the HTML for schema fidelity)");
    expect(prompt).toContain("sales.calendarHeatmap");
    expect(prompt).toContain(
      "## Proposed schema (machine-extracted; context only — the schema being registered above is the one actually published)",
    );
    expect(prompt).toContain("sales.oldSuggestion");
  });
});
