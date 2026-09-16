import { describe, expect, it } from "vitest";
import { type PromotionAction, TransitionError, transition } from "../src/index.js";

const reviewer = { id: "alice" };
const draft = {
  componentType: "sales.calendarHeatmap",
  version: "1.0.0",
  intentName: "sales.calendar_heatmap",
  description: "Heatmap",
};

describe("promotion state machine (L2→L1)", () => {
  it("canonical promotion path: in_use → … → published", () => {
    let s = transition("in_use", { kind: "nominate", by: "policy" });
    expect(s).toBe("candidate");
    s = transition(s, { kind: "judge.start" });
    expect(s).toBe("judging");
    s = transition(s, { kind: "judge.result", verdict: { pass: true, score: 0.8 } });
    expect(s).toBe("in_review");
    s = transition(s, { kind: "review.approve", reviewer });
    expect(s).toBe("approved");
    s = transition(s, { kind: "schema.propose", draft });
    expect(s).toBe("schema_proposed");
    s = transition(s, { kind: "publish", version: "1.0.0" });
    expect(s).toBe("published");
  });

  it("LIN-PRM-001: publish cannot be reached without going through a human approve", () => {
    // From any of candidate / judging / in_review, publish is an invalid transition
    for (const status of ["in_use", "candidate", "judging", "in_review"] as const) {
      expect(() => transition(status, { kind: "publish", version: "1.0.0" })).toThrow(TransitionError);
    }
    // Even from approved, publish is not possible without going through schema.propose
    expect(() => transition("approved", { kind: "publish", version: "1.0.0" })).toThrow(TransitionError);
  });

  it("a judge failure is judge_failed when judgeBlocking=true, in_review when false (advisory)", () => {
    const fail: PromotionAction = { kind: "judge.result", verdict: { pass: false, score: 0.2 } };
    expect(transition("judging", fail, { judgeBlocking: true })).toBe("judge_failed");
    expect(transition("judging", fail, { judgeBlocking: false })).toBe("in_review");
    // From judge_failed, it can recover via re-nomination
    expect(transition("judge_failed", { kind: "nominate", by: "policy" })).toBe("candidate");
  });

  it("reject / request changes / withdraw", () => {
    expect(transition("in_review", { kind: "review.reject", reviewer })).toBe("rejected");
    expect(transition("in_review", { kind: "review.requestChanges", reviewer })).toBe("changes_requested");
    expect(transition("changes_requested", { kind: "nominate", by: reviewer })).toBe("candidate");
    expect(transition("candidate", { kind: "withdraw" })).toBe("withdrawn");
    // withdraw from a terminal state is not allowed
    expect(() => transition("published", { kind: "withdraw" })).toThrow(TransitionError);
  });

  it("the path that skips judge (review.start) still requires human approval", () => {
    const s = transition("candidate", { kind: "review.start" });
    expect(s).toBe("in_review");
    expect(transition(s, { kind: "review.approve", reviewer })).toBe("approved");
  });

  it("unpublish: published → withdrawn (takedown; reuses withdrawn as the target)", () => {
    expect(transition("published", { kind: "unpublish" })).toBe("withdrawn");
    expect(transition("published", { kind: "unpublish", reason: "obsolescence" })).toBe("withdrawn");
  });

  it("unpublish is allowed only from published (otherwise TransitionError)", () => {
    for (const status of [
      "in_use",
      "candidate",
      "judging",
      "judge_failed",
      "in_review",
      "changes_requested",
      "approved",
      "schema_proposed",
      "rejected",
      "withdrawn",
    ] as const) {
      expect(() => transition(status, { kind: "unpublish" })).toThrow(TransitionError);
    }
  });

  it("withdraw on published (≠ unpublish) is TransitionError (existing guarantee invariant)", () => {
    // Only the dedicated unpublish action can handle published. withdraw keeps being rejected by the terminal guard.
    expect(() => transition("published", { kind: "withdraw" })).toThrow(TransitionError);
  });
});
