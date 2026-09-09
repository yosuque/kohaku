"""Provider-agnostic LLM contract (port of TS port.ts).

The internal implementation (the OpenAI-compatible Chat Completions adapter) is isolated in
adapters/, and the composer / evals / SemanticPort implementations depend only on this Port.

TS's zod schemas (`z.ZodType<T>`) map, in Python, to base pydantic: `type[BaseModel]` /
`TypeAdapter` as a "validating schema", and `JsonSchema` as a raw JSON Schema dynamically
built by the registry (validation is the caller's responsibility). Field names change from
TS's camelCase to snake_case (this is the product-internal Python API, not the wire contract).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypeGuard

from pydantic import BaseModel, TypeAdapter, ValidationError

from .abort import AbortSignal

type OnPartial = Callable[[object], None]
"""The recipient of the **cumulative partial object** during generation. Called by stream_object."""

type LlmEffort = Literal["low", "medium", "high", "xhigh", "max"]
"""Adaptive Reasoning effort level (Claude 4.6+/5's replacement for fixed thinking-token budgets; port of
TS's `LlmEffort`, packages/llm/src/port.ts). Five levels from least to most reasoning effort spent before
answering. See `adapters/anthropic_native.py` / `adapters/openai_compat.py` for the per-provider wiring and
which providers ignore it (gemini has no matching option)."""


@dataclass(frozen=True)
class JsonSchema:
    """A raw JSON Schema dynamically built by the registry. Not validated (the caller's responsibility)."""

    json_schema: dict[str, Any]


type SchemaInput = type[BaseModel] | TypeAdapter[Any] | JsonSchema
"""Corresponds to zod's `z.ZodType<T> | { jsonSchema }`. A pydantic model / TypeAdapter / raw JSON Schema."""


@dataclass(frozen=True)
class PromptParts:
    """An optional split of `prompt` into a leading `cacheable` part and a trailing `rest` part, for
    providers with explicit prompt caching (Anthropic's `cache_control`). Port of TS's `PromptParts`
    (packages/llm/src/port.ts) — see its doc for the full contract.

    **Invariant: `cacheable + rest == prompt`** — callers must construct both from the same content that
    produces `prompt`, never as independently-computed strings, so the invariant holds by construction.
    Purely additive: FakeLlm / FixtureLlm-equivalents (and any LlmPort that does not implement caching)
    ignore this field and read `prompt` as before.
    """

    cacheable: str
    rest: str


class SchemaValidationError(Exception):
    """A schema validation failure. The caller translates it into an INVALID_OUTPUT LlmError."""


def is_validating_schema(schema: SchemaInput) -> bool:
    """Whether this is a validating schema (pydantic-derived). `JsonSchema` is treated as pass-through, so False."""
    return not isinstance(schema, JsonSchema)


def schema_to_json_schema(schema: SchemaInput) -> dict[str, Any]:
    """Convert a schema to a JSON Schema (dict) (used for structured output and prompt attachment)."""
    if isinstance(schema, JsonSchema):
        return schema.json_schema
    if isinstance(schema, TypeAdapter):
        return schema.json_schema()
    return schema.model_json_schema()


def validate_against_schema(schema: SchemaInput, value: object) -> Any:
    """Validate a value against the schema and return the validated value. Raises SchemaValidationError on failure.

    `JsonSchema` is returned as-is without validation (by contract the caller validates it separately).
    """
    if isinstance(schema, JsonSchema):
        return value
    try:
        if isinstance(schema, TypeAdapter):
            return schema.validate_python(value)
        return schema.model_validate(value)
    except ValidationError as err:
        raise SchemaValidationError(str(err)) from err


@dataclass(frozen=True)
class GenerateObjectRequest:
    # TS's GenerateObjectRequest<T> is generic over the schema type T, but the JsonSchema branch of
    # SchemaInput is untyped and cannot bind T, so the Python version is non-generic and its result is
    # object: Any (the caller can recover a static type by receiving it with a pydantic model if needed).
    # Intentional difference.
    schema: SchemaInput
    prompt: str
    schema_name: str | None = None
    system: str | None = None
    prompt_parts: PromptParts | None = None
    """See `PromptParts`'s doc. Optional; omitted entirely when the caller has no natural cache boundary."""
    temperature: float | None = None
    """Default 0 (aids determinism; the actual guarantee is provided by the cache)."""
    max_output_tokens: int | None = None
    abort: AbortSignal | None = None
    output_budget_factor: float | None = None
    """Output-budget multiplier (>=1, default 1). Scales this call's timeout and, when max_output_tokens
    is not explicitly given, the output-token limit, to the environment setting × this multiplier. Prevents
    a call with an order-of-magnitude longer output — such as L2 free-form generation (full HTML) versus the
    standard (small L1 JSON) — from sharing the same single-call budget and running out on the time/token
    limit first. Invalid values (non-finite / less than 1) are treated as 1."""
    effort: LlmEffort | None = None
    """How much the model should reason before answering (optional; a port that does not implement effort
    control ignores this field — FakeLlm and every provider adapter with no matching option leave behavior
    unchanged). Omitted entirely means "provider default." See `LlmEffort`'s doc for which providers this
    actually reaches and under which wire field."""


@dataclass(frozen=True)
class LlmUsage:
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class GenerateObjectResult:
    object: Any
    usage: LlmUsage
    model: str


@dataclass(frozen=True)
class GenerateTextRequest:
    prompt: str
    system: str | None = None
    prompt_parts: PromptParts | None = None
    """See `PromptParts`'s doc (same contract as GenerateObjectRequest.prompt_parts)."""
    temperature: float | None = None
    max_output_tokens: int | None = None
    abort: AbortSignal | None = None
    output_budget_factor: float | None = None
    """Output-budget multiplier (>=1, default 1). Same meaning as GenerateObjectRequest.output_budget_factor."""
    effort: LlmEffort | None = None
    """Same meaning and same "ignored if unsupported" contract as GenerateObjectRequest.effort."""


@dataclass(frozen=True)
class GenerateTextResult:
    text: str
    usage: LlmUsage


class LlmPort(Protocol):
    provider: str
    model_id: str

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult: ...

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult: ...


class StreamingLlmPort(LlmPort, Protocol):
    """An LlmPort that supports streaming structured-output generation (equivalent to TS's optional `streamObject`).

    Notifies the **cumulative partial object** during generation via on_partial, while returning the final
    result as the same validated object as generate_object. Contract:

    - partial is best-effort. It may never be called at all (e.g. under the prompt JSON fallback).
    - Each on_partial is "the cumulative form up to that point" — the consumer must rebuild from scratch every
      time (so it stays safe even when a provider retry resends from the beginning). A throw from on_partial is
      swallowed (it does not break generation).
    - On a port with no implementation, the caller must fall back to generate_object (behaviorally equivalent, no partials).

    TS passes `req & { onPartial }` as an intersection type, but Python has no intersection type, so on_partial
    is split out as the second argument (intentional difference). An "optional method" also cannot be expressed
    in a Protocol, so it is modeled as a separate Protocol + the supports_streaming TypeGuard (callers fall back to generate_object).
    """

    async def stream_object(
        self, req: GenerateObjectRequest, on_partial: OnPartial
    ) -> GenerateObjectResult: ...


def supports_streaming(llm: LlmPort) -> TypeGuard[StreamingLlmPort]:
    """Whether the LlmPort implements stream_object (incremental streaming).

    If not implemented, the caller falls back to generate_object (behaviorally equivalent, no partials).
    """
    return callable(getattr(llm, "stream_object", None))


type LlmErrorCode = Literal["CONFIG", "INVALID_OUTPUT", "PROVIDER", "ABORTED"]


class LlmError(Exception):
    """A structured error with a code. The conformance / composer repair loops branch on the code."""

    def __init__(
        self,
        code: LlmErrorCode,
        message: str,
        *,
        provider: str | None = None,
        model_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.code: LlmErrorCode = code
        self.provider = provider
        self.model_id = model_id
        if cause is not None:
            self.__cause__ = cause
