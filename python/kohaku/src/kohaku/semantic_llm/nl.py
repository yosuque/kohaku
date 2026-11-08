"""Natural-language normalization (port of packages/semantic-llm/src/nl.ts): the LLM maps a question onto the
Intent catalog via structured output.

The fallback Intent is used only when the model "responded normally but it does not fit a known Intent"
(INVALID_OUTPUT, or a chosen Intent whose params fail validation). Provider failures, cancellation and
misconfiguration are thrown up to the caller (composer maps them to SEMANTIC_FAILED -> COMPOSE_FAILED) rather
than retried through a second generation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from kohaku.llm import GenerateObjectRequest, JsonSchema, LlmError, LlmPort
from kohaku.spec import JsonObject, NLQuery

from .catalog import IntentCatalogLike
from .prompt import build_normalize_system_prompt, build_normalize_user_prompt, render_catalog_doc

DEFAULT_MAX_QUESTION_CHARS = 2000
"""The default max_question_chars, applied when `normalize_nl_query` is not given one."""


class SemanticNormalizeError(Exception):
    """Thrown when normalization cannot produce a canonical Intent: the catalog is empty, the model's answer
    fits no Intent and no fallback_intent was configured, the configured fallback_intent is itself not usable,
    or the question exceeds max_question_chars."""

    code: Literal["NO_MATCH"] = "NO_MATCH"

    def __init__(
        self, text: str, message: str = "the question does not match any intent in the catalog"
    ) -> None:
        super().__init__(message)
        self.text = text


@dataclass(frozen=True)
class NlNormalization:
    canonical: str
    params: JsonObject
    fallback: bool


def _is_scalar(value: object) -> bool:
    return isinstance(value, str | int | float | bool)


async def normalize_nl_query(
    *,
    input: NLQuery,
    catalog: IntentCatalogLike,
    llm: LlmPort,
    rules: list[str],
    locale: str,
    fallback_intent: str | None = None,
    max_question_chars: int | None = None,
) -> NlNormalization:
    limit = DEFAULT_MAX_QUESTION_CHARS if max_question_chars is None else max_question_chars
    if len(input.text) > limit:
        raise SemanticNormalizeError(
            input.text, f"the question is too long (max {limit} characters)"
        )
    names = catalog.names()
    if not names:
        raise SemanticNormalizeError(input.text, "the intent catalog is empty")
    # Output schema (intent enum + params record). Passed as JsonSchema (non-validating, unlike TS's zod
    # schema); the equivalent checks are made explicitly below, and unmatched answers take the same path as
    # TS's INVALID_OUTPUT (the fallback).
    output_schema = JsonSchema(
        {
            "type": "object",
            "properties": {
                "intent": {"type": "string", "enum": names},
                "params": {
                    "type": "object",
                    "additionalProperties": {"type": ["string", "number", "boolean"]},
                },
            },
            "required": ["intent", "params"],
            "additionalProperties": False,
        }
    )

    try:
        result = await llm.generate_object(
            GenerateObjectRequest(
                schema=output_schema,
                schema_name="canonical_intent",
                system=build_normalize_system_prompt(rules),
                prompt=build_normalize_user_prompt(render_catalog_doc(catalog), locale, input.text),
                temperature=0,
            )
        )
        obj = result.object
        intent_name = obj.get("intent") if isinstance(obj, dict) else None
        raw_params = obj.get("params") if isinstance(obj, dict) else None
        if (
            isinstance(intent_name, str)
            and intent_name in names
            and isinstance(raw_params, dict)
            and all(_is_scalar(v) for v in raw_params.values())
        ):
            params = catalog.normalize_params(intent_name, raw_params)
            if params is not None:
                return NlNormalization(canonical=intent_name, params=params, fallback=False)
        # A normal response that does not fit a known Intent -> to the fallback below.
    except LlmError as e:
        # The fallback is limited to INVALID_OUTPUT (there was a response but it does not match the schema).
        # ABORTED / PROVIDER / CONFIG are not even normal responses, so they are thrown up to the caller.
        if e.code != "INVALID_OUTPUT":
            raise
    if fallback_intent is None:
        raise SemanticNormalizeError(input.text)
    if catalog.get(fallback_intent) is None:
        raise SemanticNormalizeError(
            input.text, f'the fallback intent "{fallback_intent}" is not in the catalog'
        )
    fallback_params = catalog.normalize_params(fallback_intent, {"request": input.text})
    if fallback_params is None:
        raise SemanticNormalizeError(
            input.text,
            f'the fallback intent "{fallback_intent}" rejected the fallback params {{ request }}',
        )
    return NlNormalization(canonical=fallback_intent, params=fallback_params, fallback=True)
