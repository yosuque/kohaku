import { LlmError } from "@kohaku-ui/llm";
import type { ComponentNode, EventBinding } from "@kohaku-ui/spec-core";
import { createDeadlineGuard } from "./budget.js";
import type { PreparedCompose } from "./compose.js";
import type { ComposeContext } from "./context.js";
import { reportBudgetCheckError } from "./observer.js";
import { generateL1 } from "./tiers/l1-generate.js";
import { generateL2 } from "./tiers/l2-generate.js";
import { type BudgetGate, createBudgetGate, type TierRequest, type TierResult } from "./tiers/shared.js";
import type { ComposeAttempt } from "./trace.js";

/**
 * The merged result of the generation stage (L1/L2). Instead of threading mutable flags through, expresses
 * which stage settled and how as a discriminated union.
 * - ok: the pre-validation component list (assembleSpec / postAndValidate are on the caller side).
 * - fallback: the recording material for a deterministic downgrade. from is the stage that actually failed;
 *   budgetExceeded is true only for a downgrade due to the token/call budget guard (for observer.onError's machine discrimination).
 */
export type TierOutcome =
  | {
      kind: "ok";
      tier: "L1" | "L2";
      components: ComponentNode[];
      events: EventBinding[];
      model: string | undefined;
    }
  | {
      kind: "fallback";
      from: "L1" | "L2";
      reason: string;
      budgetExceeded: boolean;
      /**
       * True when the fallback was caused by the caller's AbortSignal firing (a client disconnect or
       * timeout) rather than an actual generation failure. compose.ts marks the resulting trace
       * cancelled and hosts skip recording view.composed/view.fallback for it, so a cancel does not
       * inflate the generation-fallback-rate analytics.
       */
      cancelled?: true;
      /**
       * The classified failure kind behind this fallback, mirrored from the settling TierResult.failure.
       * Unset only for the one fallback with no underlying TierResult at all: "L2 (free-form generation)
       * is disabled in this environment" (route=L2 direct entry with allowL2 false). The L2 pre-generation
       * budget skip has no TierResult either, but is still explicitly given `failure: "budget"` by its
       * caller (runL2Stage) since the budget-guard rejection itself is exactly that failure kind. Threaded
       * by buildSpecFromOutcome (compose.ts) into ComposeErrorContext.failure so an observer can
       * machine-distinguish a provider outage from a validation failure without string-matching `reason`.
       */
      failure?: TierResult["failure"];
      /**
       * The thrown error behind this fallback (typically an LlmError), mirrored from the settling
       * TierResult.lastError. Threaded by buildSpecFromOutcome into observer.onError's `error` argument
       * (previously always undefined for a fallback). Unset whenever the terminal failure did not come
       * from a throw — see TierResult.lastError's doc for the "invalid via validate()" case.
       */
      error?: unknown;
    };

/** The "fallback" branch of TierOutcome, isolated so helpers can add `cancelled` without TS widening
 * the excess-property check against the whole TierOutcome union (which also contains the "ok" branch). */
type FallbackOutcome = Extract<TierOutcome, { kind: "fallback" }>;

/** Constructs the fallback form of a TierOutcome (the field values are decided by the caller). */
const fallback = (
  from: "L1" | "L2",
  reason: string,
  options?: { budgetExceeded?: boolean; failure?: TierResult["failure"]; error?: unknown },
): FallbackOutcome => ({
  kind: "fallback",
  from,
  reason,
  budgetExceeded: options?.budgetExceeded ?? false,
  ...(options?.failure != null ? { failure: options.failure } : {}),
  ...(options?.error !== undefined ? { error: options.error } : {}),
});

/**
 * A short, human-readable label for the LlmError code (when determinable) behind a "transient" L1/L2
 * failure, for inclusion in a fallback reason's parenthetical (e.g. "(provider error)"). Falls back to the
 * generic "transient error" when the underlying error is not an LlmError (an unexpected non-LlmError throw)
 * or carries a code this fallback path does not otherwise expect (INVALID_OUTPUT is never "transient" —
 * see isRepairableOutput — so it is not one of the cases below).
 */
function transientErrorDetail(error: unknown): string {
  if (error instanceof LlmError) {
    switch (error.code) {
      case "PROVIDER":
        return "provider error";
      case "CONFIG":
        return "configuration error";
      case "ABORTED":
        return "abort";
      default:
        break;
    }
  }
  return "transient error";
}

/** Constructs the ok form of a TierOutcome from a successful TierResult (shared by the L1 and L2 success returns). */
function okOutcome(tier: "L1" | "L2", result: TierResult): TierOutcome {
  return {
    kind: "ok",
    tier,
    components: result.components!,
    events: result.events ?? [],
    model: result.model,
  };
}

type BudgetCheckErrorReporterFor = ((failedTier: "L1" | "L2") => (error: unknown) => void) | undefined;

/**
 * One L1/L2 generation attempt's shared parameters, built once by runTierGeneration and threaded through
 * both stages (Introduce Parameter Object).
 * - `route`: the tier decided by policy.routeTier for this compose (L1 unless L2 direct entry).
 * - `from`: the "stage that actually failed" default, fixed as L2 only once L2 actually runs and fails.
 * - `budgetGate`: the budget guard shared by the pre-L2 check and both generation calls (it owns the
 *   tier → error-handler factory, which is distinct from the handler itself).
 */
interface TierRun {
  prepared: PreparedCompose;
  ctx: ComposeContext;
  attempts: ComposeAttempt[];
  route: "L1" | "L2";
  from: "L1" | "L2";
  budgetGate: BudgetGate;
  onDraftPartial?: (raw: unknown) => void;
  /**
   * The signal to pass to L1/L2 LLM calls, in place of `prepared.abort` directly: `createDeadlineGuard`'s
   * output (`prepared.abort` combined with a deadline timer when `budget.deadlineMs` is set, or
   * `prepared.abort` unchanged otherwise — see budget.ts). `createDeadlineGuard`'s `deadlineSignal` lives on
   * `budgetGate`, for mid-call abort classification.
   */
  signal: AbortSignal | undefined;
}

/**
 * The TierRequest fields common to the L1 and L2 generation calls (Extract Function); the L1-only extras
 * (`onDraftPartial`, `l1Schema`) are added by runL1Stage.
 */
function tierRequestFor(run: TierRun): TierRequest {
  const { prepared, ctx, budgetGate, signal } = run;
  return { intent: prepared.intent, refs: prepared.refs, ctx, signal, budgetGate };
}

/**
 * The stage ladder of L1 constrained generation → L2 free generation. Order of attack:
 * L1 (when route=L1) → L2 promotion eligibility → L2 budget check → L2 generation.
 * attempts are pushed onto the caller's array (usage aggregation and trace inclusion are generateSpec's responsibility).
 */
export async function runTierGeneration(
  prepared: PreparedCompose,
  ctx: ComposeContext,
  attempts: ComposeAttempt[],
  onDraftPartial?: (raw: unknown) => void,
): Promise<TierOutcome> {
  const { intent, key, traceBase, policy } = prepared;
  const budget = policy.budget;
  // Forward the occurrence of a fail-open-swallowed throw from the budget hook check() to
  // observer.onBudgetCheckError so it is never left unobserved. When budget is unspecified, do not build it
  // (exactly matching the conventional path, performance unchanged). Swap the context per tier.
  // This is a factory that takes a tier and returns the actual handler `(error) => void` (distinct from
  // generateL1/L2's argument onBudgetCheckError = the handler itself). Made self-explanatory so the two are not confused by name.
  const budgetCheckErrorReporterFor: BudgetCheckErrorReporterFor =
    budget != null
      ? (failedTier: "L1" | "L2") =>
          (error: unknown): void =>
            reportBudgetCheckError(
              ctx,
              { input: traceBase.input, intent, cacheKey: key, tier: failedTier },
              error,
            )
      : undefined;

  const route = policy.routeTier?.(intent) ?? "L1";
  // The default value of "the tier that actually failed" recorded on fallback. If route is L2 direct
  // entry, L2 (L1 does not run). Fix it to "L2" only when L2 is actually run and fails (the L2 branch below).
  const from: "L1" | "L2" = route === "L2" ? "L2" : "L1";

  // Compose-wide deadline (ComposePolicy.budget.deadlineMs). Armed once for the whole L1→L2 ladder shared
  // below (the initial L1 call, every repair re-attempt, and L2) — not re-armed per attempt — so it bounds
  // the wall-clock time of this *compose*, not any single LLM call. See createDeadlineGuard's doc (budget.ts)
  // for how signal/deadlineSignal are told apart at the classification site (tiers/shared.ts). A no-op
  // (byte-identical signal passthrough, no timer) whenever budget.deadlineMs is unset.
  const deadlineGuard = createDeadlineGuard(budget, prepared.startedAt, prepared.abort);
  try {
    const run: TierRun = {
      prepared,
      ctx,
      attempts,
      route,
      from,
      budgetGate: createBudgetGate({
        budget,
        tenant: prepared.tenant,
        startedAt: prepared.startedAt,
        deadlineSignal: deadlineGuard.deadlineSignal,
        reportFor: budgetCheckErrorReporterFor,
      }),
      signal: deadlineGuard.signal,
      ...(onDraftPartial != null ? { onDraftPartial } : {}),
    };

    const l1Outcome = await runL1Stage(run);
    if (l1Outcome != null) return l1Outcome;

    return await runL2Stage(run);
  } finally {
    // Always clear the timer once the ladder settles (success or fallback) so a deadline that never fires
    // does not leave a dangling handle.
    deadlineGuard.dispose();
  }
}

/**
 * The failure→reason table for a settled (non-promotable-or-not) L1 failure. Precedence: budget always
 * wins regardless of canL2 (both the `!canL2` branch and the dedicated budget branch produce the same
 * reason/budgetExceeded, so the kind is budget-exceeded either way); transient gets a provider-outage
 * reason either way (the wording differs slightly depending on whether L2 was skipped as a result);
 * invalid (or an unexpected undefined) is promotable to L2 (null) only when canL2 is true, else it takes
 * the plain validation-failure reason (unchanged from before this failure/error split existed — a caller
 * distinguishing a validation failure from a provider outage should key off `failure`, not string-match
 * `reason`).
 * Returns null only for the invalid/undefined + canL2 case (proceed to L2).
 */
function settleL1Failure(l1: TierResult, canL2: boolean, from: "L1" | "L2"): TierOutcome | null {
  switch (l1.failure) {
    case "aborted":
      // The caller's AbortSignal fired — a client disconnect/timeout, not a generation failure. Never
      // promoted to L2 (there is no one left to receive it), and marked cancelled so hosts skip
      // recording it as a generation fallback.
      return {
        ...fallback(from, "Generation cancelled by the caller", { failure: "aborted", error: l1.lastError }),
        cancelled: true,
      };
    case "budget":
      // L1 was aborted due to budget overage (initial skip or repair skip). Not promoted to L2 either.
      return fallback(from, l1.budgetReason ?? "Generation stopped: token budget exceeded", {
        budgetExceeded: true,
        failure: "budget",
        error: l1.lastError,
      });
    case "transient": {
      // When L1 fell with a transient failure (LLM provider unavailable, misconfigured, or an unexpected
      // non-LlmError throw), do not send it to L2 — throwing another full generation (1×timeout) at the
      // same failing provider would just hit the same failure. The reason names the provider explicitly
      // (rather than reusing the validation-failure wording below) so an operator can tell "the LLM never
      // answered" apart from "the LLM answered but the output didn't validate" without inspecting failure/error.
      const detail = transientErrorDetail(l1.lastError);
      const reason = canL2
        ? `Skipped L2 because L1 generation failed: the LLM provider was unavailable (${detail}). Check KOHAKU_LLM_PROVIDER and the provider API key.`
        : `L1 generation failed: the LLM provider was unavailable (${detail}). Check KOHAKU_LLM_PROVIDER and the provider API key.`;
      return fallback(from, reason, { failure: "transient", error: l1.lastError });
    }
    case "invalid":
    case undefined:
      // Only a schema-derived (invalid: a response existed but failed validation) L1 failure is
      // promoted to L2 (null = proceed to L2). If L2 is disabled, the reason is the plain
      // validation-failure message (unchanged wording — this is not a provider outage).
      return canL2
        ? null
        : fallback(from, "L1 constrained generation failed catalog/structure validation", {
            failure: "invalid",
            error: l1.lastError,
          });
  }
}

/**
 * The L1 stage + L2 promotion-eligibility decision. TierOutcome once settled, null when proceeding to L2.
 * If route=L1, generateL1 → an early return according to the failure kind via settleL1Failure.
 * route=L2 direct entry does not generate and only passes the allowL2 decision.
 */
async function runL1Stage(run: TierRun): Promise<TierOutcome | null> {
  const { prepared, attempts, route, from, onDraftPartial } = run;
  const canL2 = prepared.policy.allowL2 ?? false;

  if (route === "L1") {
    const l1 = await generateL1({
      ...tierRequestFor(run),
      onDraftPartial,
      l1Schema: prepared.getL1Schema,
    });
    attempts.push(...l1.attempts);
    if (l1.ok) {
      return okOutcome("L1", l1);
    }
    const settled = settleL1Failure(l1, canL2, from);
    if (settled != null) return settled;
  }

  if (!canL2) {
    // Only route=L2 direct entry reaches here (L1 success/failure has already returned above).
    return fallback(from, "L2 (free-form generation) is disabled in this environment");
  }

  return null;
}

/**
 * The L2 stage. Budget check → generateL2. Always settles with a TierOutcome
 * (one of success / budget overage / generation failure).
 */
async function runL2Stage(run: TierRun): Promise<TierOutcome> {
  const { attempts, from, budgetGate } = run;

  // The budget check before L2. Both L2 direct entry (route=L2) and L1(invalid)→L2 promotion are checked
  // here in one place. spentTokens is the usage consumed at L1 (the accumulation of attempts). When budget is unspecified, do not check and enter the conventional path.
  const l2Verdict = budgetGate.verdict("L2", attempts);
  if (!l2Verdict.allow) {
    // Skip L2 due to budget overage. from is "L2" if route=L2, or stays "L1" if suppressing an L1→L2
    // promotion (since L2 does not actually run, "the stage that actually failed" is L1 if it stopped at L1).
    return fallback(from, l2Verdict.reason ?? "Skipped L2 escalation: token budget exceeded", {
      budgetExceeded: true,
      failure: "budget",
    });
  }

  const l2 = await generateL2(tierRequestFor(run));
  attempts.push(...l2.attempts);
  if (l2.ok) {
    return okOutcome("L2", l2);
  }
  if (l2.failure === "aborted") {
    // Same rationale as L1's "aborted" branch: a client disconnect/timeout, not a generation failure.
    return {
      ...fallback("L2", "Generation cancelled by the caller", { failure: "aborted", error: l2.lastError }),
      cancelled: true,
    };
  }
  if (l2.failure === "budget") {
    // L2's repair re-attempt was aborted by budget (the initial L2 passed the l2Verdict above and
    // actually ran, and the repair after a lint failure was skipped). "The stage that actually failed" is L2.
    return fallback("L2", l2.budgetReason ?? "Skipped L2 repair retry: token budget exceeded", {
      budgetExceeded: true,
      failure: "budget",
      error: l2.lastError,
    });
  }
  // L2 was tried and failed (match from to reality). failure mirrors l2.failure ("transient" or "invalid")
  // so an observer can tell a provider outage apart from an L2 validation/lint failure the same way L1 does.
  return fallback("L2", "L2 free-form generation failed", { failure: l2.failure, error: l2.lastError });
}
