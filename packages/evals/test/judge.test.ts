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
    });
    // All criteria 0.8 and weights sum to 1.0, so the combined score is also 0.8.
    expect(verdict.score).toBe(0.8);
    expect(verdict.pass).toBe(true);
    expect(verdict.rubricId).toBe("l2-promotion");
    expect(verdict.rubricVersion).toBe("0.2");
    expect(verdict.summary).toBe("worthy of promotion");
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
  it("when the response omits a criterion its score falls back to 0 / reasoning to (not evaluated)", async () => {
    // A response that omits safety (weight 0.25) and returns full marks for the remaining 5 criteria.
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
    // The missing criterion (weight 0.25) is combined as 0 points: the remaining 5 criteria are full marks, so score = 1 - 0.25 = 0.75.
    expect(verdict.score).toBe(0.75);
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
    });
    // Only the rubric's criteria are evaluated. Unknown ids do not appear in verdict.criteria.
    expect(verdict.criteria.map((c) => c.id)).toEqual(l2PromotionRubric.criteria.map((c) => c.id));
    // All criteria 0.5, so the combination is also 0.5 (the unknown criterion's full mark 1.0 is ignored).
    expect(verdict.score).toBe(0.5);
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
