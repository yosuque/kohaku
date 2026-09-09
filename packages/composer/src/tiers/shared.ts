import { LlmError } from "@kohaku-ui/llm";
import type { GenerationSchema } from "@kohaku-ui/registry";
import type { CanonicalIntent, ComponentNode, EventBinding } from "@kohaku-ui/spec-core";
import { checkBudget, sumSpentTokens } from "../budget.js";
import type { ComposeBudget, ComposeContext } from "../context.js";
import type { ResolvedRefs } from "../refs.js";
import type { ComposeAttempt } from "../trace.js";

/**
 * Shared request parameters for one L1/L2 generation call (Introduce Parameter Object), passed
 * through unchanged from tier-ladder.ts's runL1Stage/runL2Stage.
 */
export interface TierRequest {
  intent: CanonicalIntent;
  refs: ResolvedRefs;
  ctx: ComposeContext;
  /**
   * The caller's abort signal (optional AbortSignal compatibility). Passes through to the LLM call as req.abort, and an abort
   * immediately falls to ok:false (failure="transient").
   */
  signal?: AbortSignal;
  budget?: ComposeBudget;
  /** The forwarding target for the occurrence of a fail-open-swallowed throw from the budget hook check() (for observation). Wired by compose. */
  onBudgetCheckError?: (error: unknown) => void;
  /**
   * `PreparedCompose.startedAt`, threaded through so runRepairLoop can measure elapsed wall-clock time for
   * `budget.deadlineMs`'s between-call check without calling Date.now() itself at a stage further removed
   * from the caller. Only read when `budget?.deadlineMs` is set; harmless (and conventionally omittable) otherwise.
   */
  startedAt?: number;
  /**
   * Fires only when `budget.deadlineMs` elapses (see budget.ts's createDeadlineGuard) — never by the
   * caller's own abort. Used by runRepairLoop to classify a mid-call `ABORTED` as a deadline-budget
   * fallback rather than a client cancellation. Undefined whenever `budget?.deadlineMs` is unset.
   */
  deadlineSignal?: AbortSignal;
  /**
   * The notification target for the cumulative partial draft during generation (incremental streaming).
   * Only the composeStream path passes it, and only generateL1 consumes it (generateL2 accepts and
   * ignores the field). When passed and the tier's resolved LlmPort (`resolveTierLlm(ctx, "L1")` — see
   * `ComposeContext.llmByTier`) implements `streamObject`, streaming generation is done **only on the
   * first attempt** (repair attempts are non-streaming — the
   * provisional display is already out, and re-streaming during repair would rewind the display).
   * The validation pipeline (decode → collectIssues → repair loop) is completely unchanged.
   */
  onDraftPartial?: (raw: unknown) => void;
  /**
   * The memoized L1 generation-schema getter (PreparedCompose.getL1Schema — see its doc), threaded in by
   * tier-ladder.ts's runL1Stage so generateL1 reuses the exact same schema/includeTypes pair composeStream's
   * provisional-patch decode loop may already have built, instead of building it a second time. Only
   * generateL1 consumes it (generateL2 accepts and ignores the field, matching onDraftPartial's pattern).
   * Optional so a test that constructs a TierRequest by hand without it still gets a correct (merely
   * unmemoized) schema — generateL1 falls back to building it directly when unset.
   */
  l1Schema?: () => { generation: GenerationSchema; includeTypes: string[] | undefined };
}

/**
 * Whether the output is subject to the repair loop. Only an LlmError that is INVALID_OUTPUT
 * (a response exists but fails validation) is the kind fixable by prompt feedback. Anything else
 * (ABORTED / PROVIDER / CONFIG / non-LlmError) is transient and falls back immediately.
 * A discrimination common to L1 / L2.
 */
export function isRepairableOutput(e: unknown): boolean {
  return e instanceof LlmError && e.code === "INVALID_OUTPUT";
}

/** The return shape when the token/call budget guard aborts an LLM call (the common subset of TierResult). */
export interface BudgetSkipResult {
  ok: false;
  attempts: ComposeAttempt[];
  failure: "budget";
  budgetReason?: string;
  model?: string;
}

/**
 * If the budget check says subsequent LLM calls should be skipped, returns an abort result.
 * Used by the caller while it keeps the outer condition (L1: every attempt / L2: attempt > 0).
 * Returns null when allowed (continue calling).
 * elapsedMs (wall-clock since the compose started) is forwarded to checkBudget's deadline check; pass
 * undefined (the default) when budget.deadlineMs is not in play, matching checkBudget's own contract.
 */
export function budgetSkipIfDenied(
  budget: ComposeBudget,
  attempts: ComposeAttempt[],
  onBudgetCheckError: ((error: unknown) => void) | undefined,
  model: string | undefined,
  elapsedMs?: number,
): BudgetSkipResult | null {
  const verdict = checkBudget(budget, sumSpentTokens(attempts), onBudgetCheckError, elapsedMs);
  if (!verdict.allow) {
    return {
      ok: false,
      attempts,
      failure: "budget",
      ...(verdict.reason != null ? { budgetReason: verdict.reason } : {}),
      ...(model != null ? { model } : {}),
    };
  }
  return null;
}

/** Computes the loop upper bound from the initial attempt + the number of repair re-attempts (common to L1 / L2). */
export function resolveMaxAttempts(ctx: ComposeContext): number {
  return 1 + (ctx.policy?.maxRepairAttempts ?? 1);
}

/**
 * The shared L1/L2 tier-generation result shape (structurally identical between L1 and L2). On success
 * carries the assembled components/events; on failure carries the attempt trace and failure classification
 * that compose.ts's settleL1Failure / runL2Stage branch on.
 */
export interface TierResult {
  ok: boolean;
  components?: ComponentNode[];
  events?: EventBinding[];
  model?: string;
  attempts: ComposeAttempt[];
  /**
   * The failure kind when ok:false.
   * - "transient": abort (ABORTED), provider failure (PROVIDER), misconfiguration (CONFIG), or an unexpected
   *   non-LlmError. Since throwing another full generation at the same provider in L2 would hit the same
   *   failure, compose does not promote an L1 transient failure to L2.
   * - "invalid": schema-derived (INVALID_OUTPUT) or a catalog/structural/bridge-contract validation failure.
   *   Promoted L1→L2.
   * - "budget": the token/call/deadline budget guard stopped the LLM call — either a between-call skip
   *   (initial skip or repair skip) or, for `budget.deadlineMs`, an in-flight call aborted mid-flight once
   *   the deadline elapsed (see budget.ts's createDeadlineGuard). Not promoted either. `budgetReason`
   *   carries a reason distinguishable from a token-threshold overage in either case.
   * - "aborted": the caller's own AbortSignal fired (LlmError code ABORTED, and `deadlineSignal` — when
   *   present — was NOT the one that fired). Distinguished from "transient" so the resulting fallback Spec is
   *   marked cancelled rather than treated as a generation failure — a client disconnect/timeout must not
   *   inflate the fallback-rate analytics the same way a real provider failure does. A deadline-caused abort
   *   is classified as "budget" above instead, precisely so it is NOT marked cancelled and DOES count toward
   *   that same fallback-rate analytics (it is an operator-configured budget outcome, not a client disconnect).
   */
  failure?: "transient" | "invalid" | "budget" | "aborted";
  /** The downgrade reason when failure==="budget" (compose places it on fallback.reason). */
  budgetReason?: string;
}

/** One LLM-call attempt's outcome, as reported by a runRepairLoop `call` hook on success. */
export interface RepairLoopCallResult {
  /** The raw model output, handed to `validate` unvalidated. */
  raw: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** The outcome of validating one attempt's raw output, as reported by a runRepairLoop `validate` hook. */
export type RepairLoopValidation =
  | { ok: true; components: ComponentNode[]; events: EventBinding[] }
  | { ok: false; issues: string[] };

export interface RepairLoopConfig {
  /** Loop upper bound (initial attempt + repair re-attempts). Typically resolveMaxAttempts(ctx). */
  maxAttempts: number;
  /**
   * When to run the token/call budget guard before an LLM call:
   * - "every": check before every attempt including the first (L1 — a zero budget skips the LLM entirely).
   * - "afterFirst": check only before repair re-attempts, attempt > 0 (L2 — the initial call's budget was
   *   already checked by compose.ts's runL2Stage immediately before generateL2 runs, so checking again at
   *   attempt 0 here would double-fire onBudgetCheckError for the same decision).
   */
  budgetGate: "every" | "afterFirst";
  /**
   * Performs one LLM call for `attempt`, given the repair feedback (issues) accumulated from the previous
   * attempt (empty on the first attempt). Must throw (an LlmError, ideally) on failure — the loop classifies
   * the throw via isRepairableOutput to decide whether to retry (INVALID_OUTPUT) or fall back immediately
   * (everything else, "transient").
   */
  call(feedback: string[], attempt: number): Promise<RepairLoopCallResult>;
  /**
   * Validates one attempt's raw output. Must not throw — a validation failure (decode error, lint findings,
   * structural-validation issues, etc.) is reported by returning `{ ok: false, issues }`, which the loop
   * always classifies as failure="invalid" (repairable), matching the pre-refactor behavior where such
   * failures were never treated as "transient" regardless of what internally raised them.
   */
  validate(raw: unknown, attempt: number): Promise<RepairLoopValidation>;
}

/**
 * The unified L1/L2 repair-loop skeleton (Form Template Method): budget gate → LLM call (attempt tracking +
 * transient/invalid classification via isRepairableOutput) → validate → success returns, or accumulates
 * `issues` as feedback for the next attempt. Runs at most `config.maxAttempts` times and then falls to
 * `{ ok: false, attempts, failure, model?, budgetReason? }`.
 *
 * Shared by tiers/l1-generate.ts and tiers/l2-generate.ts — see `TierResult`'s and `RepairLoopConfig`'s
 * docs for the exact contract each tier's caller relies on.
 *
 * `startedAt`/`deadlineSignal` are `budget.deadlineMs`'s two extra inputs (both undefined when it is unset,
 * which keeps this function's behavior byte-identical to before they existed): `startedAt` lets the
 * between-call budget gate above measure elapsed wall-clock time; `deadlineSignal` lets the catch block
 * below tell a deadline-caused mid-call abort apart from the caller's own AbortSignal firing.
 */
export async function runRepairLoop(
  kind: "l1" | "l2",
  config: RepairLoopConfig,
  budget: ComposeBudget | undefined,
  onBudgetCheckError: ((error: unknown) => void) | undefined,
  startedAt?: number,
  deadlineSignal?: AbortSignal,
): Promise<TierResult> {
  const attempts: ComposeAttempt[] = [];
  let feedback: string[] = [];
  let model: string | undefined;
  // The failure kind when returning ok:false. Default "invalid" (the safe side that promotes to L2 and
  // matches a repair-loop-internal validation failure, which is never "transient").
  let failure: "transient" | "invalid" | "aborted" | "budget" = "invalid";
  // Set only on the mid-call deadline-abort branch below (budgetSkipIfDenied's own BudgetSkipResult already
  // carries its own budgetReason on the early-return path — this variable is for the OTHER route into
  // failure="budget": an in-flight call aborted by the deadline timer rather than skipped before it started).
  let budgetReason: string | undefined;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    if (budget != null && (config.budgetGate === "every" || attempt > 0)) {
      const elapsedMs = budget.deadlineMs != null && startedAt != null ? Date.now() - startedAt : undefined;
      const skipped = budgetSkipIfDenied(budget, attempts, onBudgetCheckError, model, elapsedMs);
      if (skipped != null) return skipped;
    }

    let raw: unknown;
    try {
      const result = await config.call(feedback, attempt);
      raw = result.raw;
      model = result.model;
      attempts.push({ kind, ok: true, usage: result.usage });
    } catch (e) {
      attempts.push({
        kind,
        ok: false,
        issues: [e instanceof Error ? e.message : String(e)],
      });
      if (e instanceof LlmError && e.code === "ABORTED") {
        // deadlineSignal fires only from budget.ts's createDeadlineGuard, never from the caller's own
        // AbortSignal — so this reliably tells the two abort sources apart regardless of which one the LLM
        // adapter's own AbortSignal.any combination actually reports (see createDeadlineGuard's doc).
        if (deadlineSignal?.aborted === true) {
          // The compose-wide deadline elapsed while this call was already in flight. This is an
          // operator-configured budget outcome, not a client disconnect: classify it the same way a
          // between-call deadline skip is classified ("budget") so it is NOT marked cancelled and DOES
          // count toward the generation-fallback rate (see docs/design.md §5).
          failure = "budget";
          budgetReason = `Budget exceeded: deadline ${budget?.deadlineMs}ms reached during generation`;
          break;
        }
        // Otherwise: a client disconnect/timeout, not a generation failure — classify it separately from
        // "transient" so the caller can mark the resulting fallback as cancelled rather than counting it
        // against the generation-fallback rate.
        failure = "aborted";
        break;
      }
      // transient (PROVIDER: provider failure), misconfiguration (CONFIG), and an unexpected non-LlmError
      // are not the kind of failure fixable by prompt feedback. A repair re-attempt would merely
      // re-consume the full timeoutMs per attempt, so break out of the loop immediately and fall to the
      // fallback (ok:false). Limit the repair target to only the schema-derived kind (INVALID_OUTPUT: a
      // response existed but failed validation).
      if (!isRepairableOutput(e)) {
        failure = "transient";
        break;
      }
      failure = "invalid";
      continue;
    }

    const validated = await config.validate(raw, attempt);
    if (validated.ok) {
      return { ok: true, components: validated.components, events: validated.events, model, attempts };
    }
    // A validation failure is also a repair target ("invalid", L1→L2-promotable / L2-repairable).
    failure = "invalid";
    attempts[attempts.length - 1] = {
      ...attempts[attempts.length - 1]!,
      ok: false,
      issues: validated.issues,
    };
    feedback = validated.issues;
  }

  return {
    ok: false,
    attempts,
    failure,
    ...(model != null ? { model } : {}),
    ...(budgetReason != null ? { budgetReason } : {}),
  };
}
