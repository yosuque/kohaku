import type { Judge, JudgeSpecInput, JudgeVerdict } from "./judge.js";

/**
 * L1 Spec quality regression harness. Runs alongside runGolden (whether the output Spec matches the expectation).
 * Whereas runGolden checks "identity" (a match after variation normalization), this regression-checks the
 * L1 quality rubric's score via judge.judgeSpec (whether the lower bound of "how good" is upheld).
 * It can run deterministically with a judge that has FakeLlm / FixtureLlm injected (live verification of the LLM path is record/replay).
 *
 * Positioning: this harness provides the mechanism (case → judgeSpec → lower-bound gate → report) **up front**.
 * Defining the actual quality cases and wiring up FixtureLlm (record/replay) is the responsibility of the
 * consumer (the product's regression suite); here we provide only the minimal, deterministically running executor.
 */
export interface QualityCase {
  name: string;
  input: JudgeSpecInput;
  /**
   * Lower bound of the expected score. When specified, the pass condition is verdict.score >= minScore (a regression threshold gate).
   * When unspecified, verdict.pass (based on the judge's passScore) is used directly.
   */
  minScore?: number;
}

export interface QualityCaseResult {
  name: string;
  pass: boolean;
  score: number;
  verdict: JudgeVerdict;
  /**
   * The case's execution time (wall clock). **Not deterministic**: pass / score / verdict are deterministic
   * with FakeLlm/FixtureLlm injected, but durationMs is a measured value and varies per run (do not include it in regression comparisons or snapshots).
   */
  durationMs: number;
}

export interface QualityReport {
  pass: boolean;
  cases: QualityCaseResult[];
}

/** Runs the L1 quality cases through judge.judgeSpec for regression verification. */
export async function runQuality(cases: QualityCase[], judge: Judge): Promise<QualityReport> {
  const results: QualityCaseResult[] = [];
  for (const c of cases) {
    const startedAt = Date.now();
    const verdict = await judge.judgeSpec(c.input);
    const pass = c.minScore != null ? verdict.score >= c.minScore : verdict.pass;
    results.push({
      name: c.name,
      pass,
      score: verdict.score,
      verdict,
      durationMs: Date.now() - startedAt,
    });
  }
  return { pass: results.every((r) => r.pass), cases: results };
}
