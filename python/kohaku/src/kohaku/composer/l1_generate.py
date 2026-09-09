"""L1 constrained generation (port of TS tiers/l1-generate.ts).

Call the LLM with a dynamically built generation schema, verify against the true schema (catalog) +
structural validation, and on failure feed back the list of errors and repair-retry up to maxRepairAttempts times.
"""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import ValidationError

from kohaku.llm import (
    AbortSignal,
    GenerateObjectRequest,
    JsonSchema,
    LlmError,
    PromptParts,
    supports_streaming,
)
from kohaku.registry import GenerationSchema, build_generation_schema
from kohaku.spec import (
    SPEC_VERSION,
    EventBinding,
    Intent,
    UISpec,
    validate_spec_structure,
)

from .budget import ComposeBudget, check_budget, sum_spent_tokens
from .context import (
    ComposeContext,
    OnBudgetCheckError,
    OnDraftPartial,
    ResolvedRefs,
    resolve_tier_llm,
)
from .prompt import L1_SYSTEM_PROMPT, build_l1_prompt_static, repair_feedback_section
from .trace import ComposeAttempt, TokenUsage


def _relax_data_ref_constraint(json_schema: dict[str, Any]) -> dict[str, Any]:
    """Relaxes every `data.$ref` field in a generation JSON Schema from `{"type": "string", "enum": [...]}`
    (build_generation_schema's default: an intent-specific enum of resolved QueryHandle URIs) down to a
    plain `{"type": "string"}` — used only under `ComposePolicy.refConstraint == "validate"` (port of TS's
    `relaxDataRefConstraint`; see its doc for the rationale). Recognizes the shape structurally (an object
    with both a `$ref` key whose value carries an `enum` list) rather than a hardcoded path, so it survives
    unrelated shape changes to build_generation_schema's variant construction. Returns a deep copy; the
    input (which build_generation_schema may hand out from a cache) is never mutated.
    """
    clone = copy.deepcopy(json_schema)
    _relax(clone)
    return clone


def _relax(node: object) -> None:
    if isinstance(node, list):
        for item in node:
            _relax(item)
        return
    if not isinstance(node, dict):
        return
    ref_value = node.get("$ref")
    if isinstance(ref_value, dict) and isinstance(ref_value.get("enum"), list):
        node["$ref"] = {"type": "string"}
        # The enum values themselves carry nothing else worth recursing into (they are plain URI strings).
        return
    for value in node.values():
        _relax(value)


def build_l1_generation_schema(
    ctx: ComposeContext,
    refs: ResolvedRefs,
    include_types: list[str] | None,
) -> GenerationSchema:
    """Builds the L1 generation schema, applying `ComposePolicy.refConstraint`'s schema-stage relaxation
    when set to "validate" (port of TS's `buildL1GenerationSchema`). Kept as a standalone function — rather
    than inlined into `generate_l1` — so the relaxation logic and its rationale are documented in one place
    and unit-testable on their own.

    Unlike the TS counterpart (which threads `intent` through for its component-selection step), this takes
    `include_types` pre-computed by the caller instead of an `intent` argument — the Python call site already
    derives `include_types` before calling this, so an `intent` parameter would sit unread in the body.
    """
    generation = build_generation_schema(ctx.catalog, refs.uris, include_types)
    policy = ctx.policy
    if policy is not None and policy.refConstraint == "validate":
        return GenerationSchema(
            jsonSchema=_relax_data_ref_constraint(generation.jsonSchema), decode=generation.decode
        )
    return generation


@dataclass(frozen=True)
class L1Result:
    ok: bool
    attempts: list[ComposeAttempt]
    components: list[dict[str, Any]] | None = None
    """Raw nodes in wire form (schema validation is done by post + final parse — the same lazy validation as TS)"""
    events: list[dict[str, Any]] | None = None
    model: str | None = None
    failure: Literal["transient", "invalid", "budget", "aborted"] | None = None
    """Failure kind when ok=False:
    - "transient": provider failure (PROVIDER), misconfiguration (CONFIG), or an unexpected exception.
      Throwing another full generation at the same provider for L2 would hit the same failure, so it is not escalated to L2.
    - "invalid": schema-derived (INVALID_OUTPUT) or a catalog/structural validation failure. Escalated to L2.
    - "budget": the budget guard stopped the LLM call. Not escalated to L2 either.
    - "aborted": the caller's AbortSignal fired (LlmError code ABORTED). Distinguished from "transient" so the
      resulting fallback Spec is marked cancelled rather than treated as a generation failure — a client
      disconnect/timeout must not inflate the fallback-rate analytics the same way a real provider failure does.
    """
    budgetReason: str | None = None


async def generate_l1(
    intent: Intent,
    refs: ResolvedRefs,
    ctx: ComposeContext,
    signal: AbortSignal | None = None,
    budget: ComposeBudget | None = None,
    on_budget_check_error: OnBudgetCheckError | None = None,
    on_draft_partial: OnDraftPartial | None = None,
    *,
    started_at: float | None = None,
    deadline_signal: AbortSignal | None = None,
) -> L1Result:
    """on_draft_partial is the notification target for the in-progress cumulative partial draft (only the
    compose_stream path passes it). When it is passed and the tier's resolved LlmPort
    (`resolve_tier_llm(ctx, "L1")` — see `ComposeContext.llmByTier`) implements stream_object, generation
    streams **only on the first attempt** (repair attempts are non-streaming — the provisional display is
    already out, and re-streaming during repair would rewind the display). The final object is the same
    validated form as generate_object, so the validation pipeline does not branch.

    `started_at` (`PreparedCompose.started_at`, `time.monotonic()` seconds) lets the between-call budget gate
    below measure elapsed wall-clock time for `budget.deadline_ms`; only read when `budget.deadline_ms` is
    set, harmless (and conventionally omittable) otherwise. `deadline_signal` fires only when
    `budget.deadline_ms` elapses (see budget.py's `create_deadline_guard`) — never by the caller's own abort
    — and lets the except block below tell a deadline-caused mid-call abort apart from a genuine client
    cancellation. Both are None whenever `budget.deadline_ms` is unset, keeping this function's behavior
    byte-identical to before they existed.
    """
    policy = ctx.policy
    # Candidate narrowing. selectComponents is deterministic for the intent. Thread the same include_types
    # through both the schema and the prompt to prevent divergence in the generation vocabulary.
    include_types = (
        policy.selectComponents(intent, ctx.catalog)
        if policy is not None and policy.selectComponents is not None
        else None
    )
    generation = build_l1_generation_schema(ctx, refs, include_types)
    max_attempts = 1 + (policy.maxRepairAttempts if policy is not None else 1)
    attempts: list[ComposeAttempt] = []
    feedback: list[str] = []
    model: str | None = None
    # ComposeContext.llmByTier resolution (additive; resolves to ctx.llm when unset — see resolve_tier_llm's doc).
    llm = resolve_tier_llm(ctx, "L1")
    effort = policy.effort.l1 if policy is not None and policy.effort is not None else None
    # Failure kind when returning ok=False. Default "invalid" (the safe side that escalates to L2 as before).
    failure: Literal["transient", "invalid", "aborted", "budget"] = "invalid"
    # Set only on the mid-call deadline-abort branch below (the between-call budget skip's own L1Result
    # already carries its own budgetReason on that early-return path — this variable is for the OTHER route
    # into failure="budget": an in-flight call aborted by the deadline timer rather than skipped before it started).
    budget_reason: str | None = None

    # few-shot is fetched exactly once before the loop, and the same examples are injected into every attempt
    # including repair retries. A throw from examples() is swallowed and treated as empty (a supply-side
    # failure must not stop generation).
    few_shot_policy = policy.fewShot if policy is not None else None
    few_shot: list[Any] = []
    if few_shot_policy is not None:
        try:
            few_shot = list(await few_shot_policy.examples(intent))[: few_shot_policy.maxExamples]
        except Exception:  # noqa: BLE001
            few_shot = []

    # The static portion of the L1 prompt (everything but the trailing repair-feedback section) depends
    # only on intent/catalog/refs/include_types/few_shot/output_language — all fixed for the lifetime of
    # this call — so it is built exactly once here (port of TS's staticPrompt) rather than rebuilt on every
    # repair re-attempt. It also doubles as `promptParts.cacheable` below.
    static_prompt = build_l1_prompt_static(
        intent=intent,
        catalog=ctx.catalog,
        refs=refs.uris,
        shapes_by_ref=refs.shapesByRef,
        include_types=include_types,
        few_shot=few_shot if len(few_shot) > 0 else None,
        output_language=policy.outputLanguage if policy is not None else None,
    )

    for _attempt in range(max_attempts):
        # Budget verdict: decide right before this LLM call (first = before generation / 2nd+ = before repair).
        # If rejected on the first, the LLM is never called (zero budget → immediate fallback).
        if budget is not None:
            elapsed_ms = (
                (time.monotonic() - started_at) * 1000
                if budget.deadline_ms is not None and started_at is not None
                else None
            )
            verdict = check_budget(budget, sum_spent_tokens(attempts), on_budget_check_error, elapsed_ms)
            if not verdict.allow:
                return L1Result(
                    ok=False,
                    attempts=attempts,
                    failure="budget",
                    budgetReason=verdict.reason,
                    model=model,
                )
        raw: object
        try:
            # Built via repair_feedback_section — the same helper build_l1_prompt_parts uses internally —
            # rather than re-deriving it through an append_l1_repair_feedback("", feedback) empty-string
            # trick or by calling build_l1_prompt_parts itself (which would rebuild static_prompt on every
            # repair attempt). This keeps the cacheable + rest == prompt invariant anchored to one function
            # (port of TS's tiers/l1-generate.ts change).
            prompt_rest = repair_feedback_section(feedback if len(feedback) > 0 else None)
            request = GenerateObjectRequest(
                schema=JsonSchema(generation.jsonSchema),
                schema_name="ui_spec_draft",
                system=L1_SYSTEM_PROMPT,
                prompt=static_prompt + prompt_rest,
                # static_prompt is already the byte-identical prefix shared by every attempt of this call;
                # the only part that varies per attempt is the trailing repair-feedback suffix, so that
                # alone is `rest` (cacheable + rest == prompt holds by construction). Purely additive: a
                # non-caching LlmPort ignores this field and reads `prompt` (port of TS's promptParts wiring
                # in tiers/l1-generate.ts).
                prompt_parts=PromptParts(cacheable=static_prompt, rest=prompt_rest),
                temperature=0,
                abort=signal,
                effort=effort,
            )
            # Incremental streaming: use stream_object only on the first attempt and when both the notification
            # target and the port implementation are present. The final object is the same validated form as
            # generate_object, so the pipeline downstream does not branch.
            if _attempt == 0 and on_draft_partial is not None and supports_streaming(llm):
                result = await llm.stream_object(request, on_draft_partial)
            else:
                result = await llm.generate_object(request)
            raw = result.object
            model = result.model
            attempts.append(
                ComposeAttempt(
                    kind="l1",
                    ok=True,
                    usage=TokenUsage(
                        inputTokens=result.usage.input_tokens,
                        outputTokens=result.usage.output_tokens,
                    ),
                )
            )
        except Exception as e:  # noqa: BLE001 — LLM-call failures branch by kind
            attempts.append(ComposeAttempt(kind="l1", ok=False, issues=[str(e)]))
            if isinstance(e, LlmError) and e.code == "ABORTED":
                # deadline_signal fires only from budget.py's create_deadline_guard, never from the caller's
                # own AbortSignal — so this reliably tells the two abort sources apart regardless of which
                # one the LLM adapter's own AbortSignal.any combination actually reports (see
                # create_deadline_guard's doc).
                if deadline_signal is not None and deadline_signal.aborted:
                    # The compose-wide deadline elapsed while this call was already in flight. This is an
                    # operator-configured budget outcome, not a client disconnect: classify it the same way
                    # a between-call deadline skip is classified ("budget") so it is NOT marked cancelled
                    # and DOES count toward the generation-fallback rate (see docs/design.md §5).
                    failure = "budget"
                    budget_reason = (
                        f"Budget exceeded: deadline {budget.deadline_ms}ms reached during generation"
                        if budget is not None
                        else None
                    )
                    break
                # Otherwise: a client disconnect/timeout, not a generation failure — classify it separately
                # from "transient" so the caller can mark the resulting fallback as cancelled rather than
                # counting it against the generation-fallback rate.
                failure = "aborted"
                break
            # transient failures (PROVIDER / CONFIG or an unexpected non-LlmError) are not the kind that
            # prompt feedback can fix. A repair retry would only re-consume the full timeout per attempt, so
            # break out of the loop immediately and fall back. Limit the repair target to schema-derived
            # cases only (INVALID_OUTPUT: a response arrived but failed validation).
            if not (isinstance(e, LlmError) and e.code == "INVALID_OUTPUT"):
                failure = "transient"
                break
            failure = "invalid"
            continue

        try:
            draft = generation.decode(raw)
            issues = _collect_issues(draft.components, draft.events, intent, refs, ctx)
            if len(issues) == 0:
                return L1Result(
                    ok=True,
                    components=draft.components,
                    events=draft.events,
                    model=model,
                    attempts=attempts,
                )
            # A catalog/structural validation failure is also a repair target ("invalid", escalatable to L2).
            failure = "invalid"
            attempts[-1] = ComposeAttempt(kind="l1", ok=False, issues=issues, usage=attempts[-1].usage)
            feedback = issues
        except ValueError as e:
            # A defensive throw from decode (not an array / a non-object element / on・emit not a string) is
            # "a response arrived but the form is invalid", so treat it as a repairable "invalid" (raising a
            # hard exception would turn the whole compose into INTERNAL / a host 500).
            message = str(e)
            failure = "invalid"
            attempts[-1] = ComposeAttempt(
                kind="l1", ok=False, issues=[message], usage=attempts[-1].usage
            )
            feedback = [message]

    return L1Result(ok=False, attempts=attempts, failure=failure, model=model, budgetReason=budget_reason)


def _collect_issues(
    components: list[dict[str, Any]],
    events: list[dict[str, Any]],
    intent: Intent,
    refs: ResolvedRefs,
    ctx: ComposeContext,
) -> list[str]:
    issues: list[str] = []

    catalog_result = ctx.catalog.validate(components, events)
    issues.extend(f"{i.code} ({i.componentId}): {i.message}" for i in catalog_result.issues)

    # Validate events against the spec's EventBinding schema. The generation schema's enum (emit) and on format
    # are not enforced on the prompt-JSON fallback path, so send invalid forms back here as repair issues to
    # prevent them from turning into INTERNAL at final parse.
    validated_events: list[EventBinding] = []
    for i, e in enumerate(events):
        try:
            validated_events.append(EventBinding.model_validate(e))
        except ValidationError as err:
            issues.append(f"EVENT_INVALID (events[{i}]): {err}")

    # Run structural validation under a provisional envelope (do not throw even if components are malformed).
    try:
        provisional = UISpec.model_validate(
            {
                "kohaku": SPEC_VERSION,
                "intent": intent.to_wire(),
                "dataVersion": refs.dataVersion,
                "components": components
                if len(components) > 0
                else [{"id": "root", "type": "layout.stack", "props": {}}],
                "events": [e.to_wire() for e in validated_events],
                "provenance": {"tier": "L1", "composedBy": "composer", "cache": "miss"},
            }
        )
        issues.extend(
            f"{i.code}: {i.message}"
            for i in validate_spec_structure(provisional)
            if i.severity == "error"
        )
    except ValidationError as err:
        # A schema-nonconforming draft (invalid id format, etc.) does not reach structural validation — make it a repair issue.
        issues.append(f"DRAFT_INVALID: {err}")

    # Set-membership validation of data.$ref. Under the default ComposePolicy.refConstraint ("schema"),
    # this is defense in depth: the generation schema's $ref enum is not enforced on the prompt-JSON
    # fallback path, so re-confirm on the server side that each component's data.$ref belongs to the URI
    # set resolved by the SemanticPort. Under refConstraint "validate", the generation schema never
    # constrained $ref to an enum in the first place (build_l1_generation_schema relaxes it to a plain
    # string), so this check is the *primary* enforcement mechanism — flagged with the distinct
    # DATA_REF_UNRESOLVED code so it reads as the expected outcome of that mode rather than the
    # schema-bypass case INVALID_REF names (port of TS's l1-generate.ts). If an out-of-set $ref is
    # delivered/cached as-is, the host would issue a read capability for a reference unrelated to the Intent.
    allowed_refs = set(refs.uris)
    ref_constraint = ctx.policy.refConstraint if ctx.policy is not None else "schema"
    out_of_set_ref_code = "DATA_REF_UNRESOLVED" if ref_constraint == "validate" else "INVALID_REF"
    for c in components:
        data = c.get("data")
        ref = data.get("$ref") if isinstance(data, dict) else None
        if ref is not None and ref not in allowed_refs:
            node_id = c.get("id", "")
            issues.append(
                f'{out_of_set_ref_code} ({node_id}): data.$ref "{ref}" is not in the resolved reference set'
            )

    if len(components) == 0:
        issues.append("components is empty")

    return issues
