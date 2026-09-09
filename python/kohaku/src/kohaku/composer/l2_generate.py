"""L2 free-form generation (port of TS tiers/l2-generate.ts).

A sandbox-only escape hatch. The generated HTML is contracted to fetch data only via the window.kohaku
bridge API, and is placed on the Spec as an artifact (inline + sha256). Execution is isolated by the sandbox
(on the browser side). The output is checked by the bridge-contract lint (collect_l2_issues); on failure the
issues are fed back and, as with L1, repair-retried up to maxRepairAttempts times.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

from kohaku.llm import AbortSignal, GenerateTextRequest, LlmError
from kohaku.spec import SANDBOX_HTML_TYPE, Intent, sha256_hex

from .budget import ComposeBudget, check_budget, sum_spent_tokens
from .context import (
    ComposeContext,
    L2SmokeContext,
    OnBudgetCheckError,
    ResolvedRefs,
    resolve_tier_llm,
)
from .l2_lint import collect_l2_issues, extract_html_document, extract_title
from .prompt import L2_SYSTEM_PROMPT, build_l2_prompt_parts
from .trace import ComposeAttempt, TokenUsage

L2_OUTPUT_BUDGET_FACTOR = 3
"""L2 output-budget multiplier. Because L2 generates full HTML (measured at 6–12KB), the L1-based (small JSON)
timeout / output-token cap would exhaust the cap side first. Enlarge both time and output tokens by 3x."""


@dataclass(frozen=True)
class L2Result:
    ok: bool
    attempts: list[ComposeAttempt]
    components: list[dict[str, Any]] | None = None
    events: list[dict[str, Any]] | None = None
    model: str | None = None
    failure: Literal["transient", "invalid", "budget", "aborted"] | None = None
    """"aborted" (the caller's AbortSignal fired, LlmError code ABORTED) is distinguished from "transient" so
    the resulting fallback Spec is marked cancelled rather than treated as a generation failure."""
    budgetReason: str | None = None


async def generate_l2(
    intent: Intent,
    refs: ResolvedRefs,
    ctx: ComposeContext,
    signal: AbortSignal | None = None,
    budget: ComposeBudget | None = None,
    on_budget_check_error: OnBudgetCheckError | None = None,
    *,
    started_at: float | None = None,
    deadline_signal: AbortSignal | None = None,
) -> L2Result:
    """`started_at`/`deadline_signal` are `budget.deadline_ms`'s two extra inputs (both None when it is
    unset, which keeps this function's behavior byte-identical to before they existed): `started_at` lets
    the between-call budget gate below measure elapsed wall-clock time; `deadline_signal` lets the except
    block below tell a deadline-caused mid-call abort apart from the caller's own AbortSignal firing."""
    attempts: list[ComposeAttempt] = []
    # The sandbox bridge only allows a ref that exactly matches the sandbox node's data.$ref (the sandbox1 node
    # below declares only primary_ref). Present only primary_ref as "available" in the prompt too, so the
    # allowlist and the contract match.
    primary_ref = refs.uris[0] if len(refs.uris) > 0 else None
    prompt_refs = [primary_ref] if primary_ref is not None else []
    shapes_for_prompt = {
        uri: shape for uri, shape in refs.shapesByRef.items() if uri == primary_ref
    }
    max_attempts = 1 + (ctx.policy.maxRepairAttempts if ctx.policy is not None else 1)
    # Design-system application (ComposePolicy.designSystem). Wire the prompt-section insertion and the
    # enabling of the hard-coded-color lint (L2_RAW_COLOR) (enforceTokenColors default True) as a pair (same as TS).
    design_system = ctx.policy.designSystem if ctx.policy is not None else None
    enforce_token_colors = design_system is not None and design_system.enforceTokenColors
    feedback: list[str] = []
    model: str | None = None
    failure: Literal["transient", "invalid", "aborted", "budget"] = "invalid"
    # Set only on the mid-call deadline-abort branch below (the between-call budget skip's own L2Result
    # already carries its own budgetReason on that early-return path — this variable is for the OTHER route
    # into failure="budget": an in-flight call aborted by the deadline timer rather than skipped before it started).
    budget_reason: str | None = None
    # ComposeContext.llmByTier resolution (additive; resolves to ctx.llm when unset — see resolve_tier_llm's doc).
    llm = resolve_tier_llm(ctx, "L2")
    effort = ctx.policy.effort.l2 if ctx.policy is not None and ctx.policy.effort is not None else None

    for attempt in range(max_attempts):
        # Budget verdict: on the first (attempt 0) the compose-side "before L2" verdict was just made, so do not
        # double-decide (avoid double-firing on_budget_check_error). A repair retry (attempt 1+) is an additional
        # LLM call that this loop adds, so decide right before it, same as L1.
        if attempt > 0 and budget is not None:
            elapsed_ms = (
                (time.monotonic() - started_at) * 1000
                if budget.deadline_ms is not None and started_at is not None
                else None
            )
            verdict = check_budget(budget, sum_spent_tokens(attempts), on_budget_check_error, elapsed_ms)
            if not verdict.allow:
                return L2Result(
                    ok=False,
                    attempts=attempts,
                    failure="budget",
                    budgetReason=verdict.reason,
                    model=model,
                )

        html: str
        try:
            # L2 generates a raw HTML document via generate_text (not JSON-wrapped). Small models break
            # systematically in the "embed long HTML into a JSON string field" format, so use the format the
            # model can write most naturally.
            # build_l2_prompt_parts's {cacheable, rest} concatenation is byte-identical to build_l2_prompt's
            # output — cacheable is everything fixed across this call's repair re-attempts (intent / refs /
            # shape / design_system / output_language), rest is only the trailing repair-feedback section
            # that actually differs attempt-to-attempt. Purely additive: a non-caching LlmPort ignores it
            # (port of TS's promptParts wiring in tiers/l2-generate.ts).
            prompt_parts = build_l2_prompt_parts(
                intent=intent,
                refs=prompt_refs,
                shapes_by_ref=shapes_for_prompt,
                design_system=design_system,
                output_language=ctx.policy.outputLanguage if ctx.policy is not None else None,
                repair_feedback=feedback if len(feedback) > 0 else None,
            )
            result = await llm.generate_text(
                GenerateTextRequest(
                    system=L2_SYSTEM_PROMPT,
                    prompt=prompt_parts.cacheable + prompt_parts.rest,
                    prompt_parts=prompt_parts,
                    temperature=0,
                    output_budget_factor=L2_OUTPUT_BUDGET_FACTOR,
                    abort=signal,
                    effort=effort,
                )
            )
            # model is the tier's actually-used port's model_id (llm, resolved via resolve_tier_llm) rather
            # than the base ctx.llm — generate_text's own result carries no model field (unlike
            # GenerateObjectResult), so this is the only place the actual model identity is available to
            # record into the attempt/trace. (Bug fix: this used to unconditionally read ctx.llm.model_id
            # even when llmByTier.L2 was in play — matching the TS side's WP2 fix.)
            model = llm.model_id
            attempts.append(
                ComposeAttempt(
                    kind="l2",
                    ok=True,
                    usage=TokenUsage(
                        inputTokens=result.usage.input_tokens,
                        outputTokens=result.usage.output_tokens,
                    ),
                )
            )
            html = extract_html_document(result.text)
        except Exception as e:  # noqa: BLE001 — LLM-call failures branch by kind
            attempts.append(ComposeAttempt(kind="l2", ok=False, issues=[str(e)]))
            if isinstance(e, LlmError) and e.code == "ABORTED":
                # deadline_signal fires only from budget.py's create_deadline_guard, never from the caller's
                # own AbortSignal — see generate_l1's identical branch for the full rationale.
                if deadline_signal is not None and deadline_signal.aborted:
                    failure = "budget"
                    budget_reason = (
                        f"Budget exceeded: deadline {budget.deadline_ms}ms reached during generation"
                        if budget is not None
                        else None
                    )
                    break
                # Otherwise: a client disconnect/timeout, not a generation failure — classify it separately
                # from "transient" so the caller can mark the resulting fallback as cancelled.
                failure = "aborted"
                break
            # A transient failure is not one that prompt feedback can fix, so do not repair-retry.
            if not (isinstance(e, LlmError) and e.code == "INVALID_OUTPUT"):
                failure = "transient"
                break
            failure = "invalid"
            continue

        issues = collect_l2_issues(html, enforce_token_colors=enforce_token_colors)
        # JS syntax check (L2_SCRIPT_SYNTAX): Python has no JS runtime, so it is injectable (TS builds it into
        # collect_l2_issues via new Function). Call it only when wired, and merge the returned issues into the
        # existing lint (into the same repair loop). A throw is fail-open (check skipped = classic behavior).
        # When unwired, it is skipped.
        if ctx.policy is not None and ctx.policy.l2ScriptSyntax is not None:
            try:
                issues = [*issues, *await ctx.policy.l2ScriptSyntax(html)]
            except Exception:  # noqa: BLE001,S110 — a verifier failure must not stop L2 delivery (fail-open)
                pass
        # After the static lint passes, pre-delivery smoke verification (optional hook). It detects failures that
        # the lexical lint slips past — e.g. never reaching ready() due to a runtime TypeError — and sends them
        # back for repair. A throw is fail-open (check skipped = classic behavior; like the budget hook, a
        # verifier failure must not stop L2 delivery).
        if len(issues) == 0 and ctx.policy is not None and ctx.policy.l2Smoke is not None:
            shape = refs.shapesByRef.get(primary_ref) if primary_ref is not None else None
            try:
                issues = await ctx.policy.l2Smoke(html, L2SmokeContext(ref=primary_ref, shape=shape))
            except Exception:  # noqa: BLE001,S110 — a verifier failure must not stop L2 delivery (fail-open)
                issues = []
        if len(issues) == 0:
            request = intent.params.get("request")
            fallback_title = (
                request if isinstance(request, str) and request != "" else "Custom view"
            )
            title = extract_title(html, fallback_title)
            sha256 = sha256_hex(html)
            components: list[dict[str, Any]] = [
                {
                    "id": "root",
                    "type": "layout.stack",
                    "props": {"direction": "vertical", "gap": "md"},
                    "children": ["title1", "sandbox1"],
                },
                {"id": "title1", "type": "text.heading", "props": {"level": 2, "text": title}},
                {
                    "id": "sandbox1",
                    "type": SANDBOX_HTML_TYPE,
                    "props": {"title": title},
                    "artifact": {"inline": html, "sha256": sha256},
                    **({"data": {"$ref": primary_ref}} if primary_ref is not None else {}),
                },
            ]
            return L2Result(ok=True, components=components, events=[], model=model, attempts=attempts)
        # A bridge-contract lint failure is a repair target. Send the issues back as feedback to the next attempt.
        failure = "invalid"
        attempts[-1] = ComposeAttempt(kind="l2", ok=False, issues=issues, usage=attempts[-1].usage)
        feedback = issues

    return L2Result(ok=False, attempts=attempts, failure=failure, model=model, budgetReason=budget_reason)
