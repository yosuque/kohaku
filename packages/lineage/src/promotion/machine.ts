import { GOVERNANCE_ERROR_DISCRIMINATORS, type Principal } from "@kohaku-ui/spec-core";

/**
 * State machine for L2 -> L1 promotion. Implemented as a table-driven pure function so the
 * conformance test (LIN-PRM-001: a human approve must precede publish) can be verified.
 */
export type PromotionStatus =
  | "in_use"
  | "candidate"
  | "judging"
  | "judge_failed"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "schema_proposed"
  | "published"
  | "rejected"
  | "withdrawn";

export interface ComponentDraft {
  componentType: string;
  version: string;
  intentName: string;
  description: string;
  /** JSON Schema for the props (LLM-extracted or a human-entered draft) */
  paramsJsonSchema?: unknown;
  /**
   * Data wiring for the promotion Intent (product default when omitted): mapping of intent params -> query://.
   * - path: the query path (e.g. "trend")
   * - fixedParams: fixed parameters always attached
   * - paramMap: intent param name -> query param name (values are String()-converted)
   */
  queryTemplate?: {
    path: string;
    fixedParams?: Record<string, string>;
    paramMap?: Record<string, string>;
  };
}

/**
 * The verdict returned by the judge stage (LLM-as-Judge etc.; also the shape PromotionJudge resolves to).
 * rubricId / rubricVersion are additive optional: they transcribe which rubric version judged into the
 * component.judged verdict to stamp it in the audit. The legacy { pass, score, reason } is also valid.
 * Mirrors the Python port's JudgeResult.
 */
export interface JudgeVerdict {
  pass: boolean;
  score: number;
  reason?: string;
  rubricId?: string;
  rubricVersion?: string;
}

export type PromotionAction =
  | { kind: "nominate"; by: "policy" | Principal }
  | { kind: "judge.start" }
  | { kind: "judge.result"; verdict: JudgeVerdict }
  | { kind: "review.start" }
  | { kind: "review.approve"; reviewer: Principal; comment?: string }
  | { kind: "review.requestChanges"; reviewer: Principal; comment?: string }
  | { kind: "review.reject"; reviewer: Principal; comment?: string }
  | { kind: "schema.propose"; draft: ComponentDraft }
  | { kind: "publish"; version: string }
  | { kind: "withdraw"; reason?: string }
  | { kind: "unpublish"; reason?: string };

export interface MachinePolicy {
  /** Whether a judge failure blocks promotion (false means it is treated as advisory and proceeds to in_review) */
  judgeBlocking: boolean;
}

export class TransitionError extends Error {
  constructor(status: PromotionStatus, action: PromotionAction["kind"]) {
    super(`invalid promotion transition: ${action} is not allowed in status "${status}"`);
    // The name is a wire-adjacent discriminator matched structurally by host-rest (shared via spec-core).
    this.name = GOVERNANCE_ERROR_DISCRIMINATORS.transitionName;
  }
}

const TERMINAL: PromotionStatus[] = ["published", "rejected", "withdrawn"];

/** Pure-function state transition. An invalid transition throws TransitionError. */
export function transition(
  status: PromotionStatus,
  action: PromotionAction,
  policy: MachinePolicy = { judgeBlocking: true },
): PromotionStatus {
  if (action.kind === "withdraw") {
    if (TERMINAL.includes(status)) throw new TransitionError(status, action.kind);
    return "withdrawn";
  }

  switch (status) {
    case "in_use":
    case "judge_failed":
    case "changes_requested":
      if (action.kind === "nominate") return "candidate";
      break;
    case "candidate":
      if (action.kind === "judge.start") return "judging";
      if (action.kind === "review.start") return "in_review"; // path that skips judge (a record still remains)
      break;
    case "judging":
      if (action.kind === "judge.result") {
        return action.verdict.pass || !policy.judgeBlocking ? "in_review" : "judge_failed";
      }
      break;
    case "in_review":
      if (action.kind === "review.approve") return "approved";
      if (action.kind === "review.requestChanges") return "changes_requested";
      if (action.kind === "review.reject") return "rejected";
      break;
    case "approved":
      if (action.kind === "schema.propose") return "schema_proposed";
      break;
    case "schema_proposed":
      if (action.kind === "publish") return "published";
      break;
    case "published":
      // Withdrawal from published. The target state does not create a new state but reuses "withdrawn":
      // because artifactId derives from sha256 (content), re-publishing the same artifact would, for audit
      // purposes, mean "the same thing." Re-publishing correctly goes via a new artifact, so this target being
      // terminal is fine. The TERMINAL array and withdraw's early return mean a published->withdrawn
      // via the withdraw action (not unpublish) remains a TransitionError (does not break existing tests' guarantees).
      if (action.kind === "unpublish") return "withdrawn";
      break;
    default:
      break;
  }
  throw new TransitionError(status, action.kind);
}

export function isTerminal(status: PromotionStatus): boolean {
  return TERMINAL.includes(status);
}
