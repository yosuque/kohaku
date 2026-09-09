"""Scripted-response LLM for tests and CI (port of TS fake.ts).

Records calls and, when a validating schema (pydantic) is given, validates the scripted response
to catch fixture mistakes on the test side early. Used in place of tests that call a real LLM.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from .port import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextRequest,
    GenerateTextResult,
    LlmEffort,
    LlmError,
    LlmUsage,
    OnPartial,
    SchemaValidationError,
    is_validating_schema,
    validate_against_schema,
)


@dataclass(frozen=True)
class FakeLlmCall:
    kind: Literal["object", "text"]
    prompt: str
    system: str | None = None
    schema_name: str | None = None
    effort: LlmEffort | None = None
    """The request's `effort`, when the caller passed one (WP1 test hook — FakeLlm never acts on this itself)."""


_USAGE = LlmUsage(input_tokens=0, output_tokens=0)
_UNSET = object()

type ObjectScript = list[Any] | Callable[[GenerateObjectRequest], Any]
type TextScript = list[str] | Callable[[GenerateTextRequest], str]


class FakeLlm:
    def __init__(
        self,
        *,
        objects: ObjectScript | None = None,
        texts: TextScript | None = None,
        partials: list[list[Any]] | None = None,
        provider: str = "fake",
        model_id: str = "fake-model",
    ) -> None:
        self.objects: ObjectScript = objects if objects is not None else []
        self.texts: TextScript = texts if texts is not None else []
        # partials[i] = the sequence of cumulative partials to notify before the final response (objects[i])
        # on the i-th stream_object call (for testing the StreamingLlmPort.stream_object contract). Not used
        # via generate_object. Reproducing the cumulative form is the script's responsibility.
        self.partials: list[list[Any]] = partials if partials is not None else []
        self.calls: list[FakeLlmCall] = []
        self._object_index = 0
        self._text_index = 0
        # Overrides the default "fake"/"fake-model" identity. Lets a test construct two distinguishable
        # FakeLlm instances, for asserting ComposeContext.llmByTier routing and cacheKey separation.
        self.provider = provider
        self.model_id = model_id

    async def stream_object(
        self, req: GenerateObjectRequest, on_partial: OnPartial
    ) -> GenerateObjectResult:
        # Notify the corresponding scripted partial sequence in order before the final response. Swallow a throw
        # from on_partial (port contract: a consumer exception must not break generation). generate_object advances
        # the index (the current _object_index here matches what generate_object will consume).
        scripted = self.partials[self._object_index] if self._object_index < len(self.partials) else []
        for partial in scripted:
            try:
                on_partial(partial)
            except Exception:  # noqa: BLE001,S110 — swallowed as per the contract
                pass
        return await self.generate_object(req)

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        self.calls.append(
            FakeLlmCall(
                kind="object",
                prompt=req.prompt,
                system=req.system,
                schema_name=req.schema_name,
                effort=req.effort,
            )
        )
        # The function path has no side effects. The array path uses "peek → validate → advance index only on
        # success" so that even if schema validation throws, the consumption position does not shift (to avoid
        # breaking record/replay-style usage where the same response is re-consumed after a validation failure).
        objects = self.objects
        raw: Any
        if callable(objects):
            is_fn = True
            raw = objects(req)
        else:
            is_fn = False
            raw = objects[self._object_index] if self._object_index < len(objects) else _UNSET
        if raw is _UNSET:
            raise LlmError("INVALID_OUTPUT", "FakeLlm: no scripted object response left")
        if is_validating_schema(req.schema):
            try:
                parsed = validate_against_schema(req.schema, raw)
            except SchemaValidationError as err:
                # Throw without advancing the index (a validation failure is treated as not consumed).
                raise LlmError(
                    "INVALID_OUTPUT",
                    f"FakeLlm: scripted response does not match schema: {err}",
                ) from err
            if not is_fn:
                self._object_index += 1
            return GenerateObjectResult(object=parsed, usage=_USAGE, model=self.model_id)
        if not is_fn:
            self._object_index += 1
        return GenerateObjectResult(object=raw, usage=_USAGE, model=self.model_id)

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        self.calls.append(
            FakeLlmCall(kind="text", prompt=req.prompt, system=req.system, effort=req.effort)
        )
        texts = self.texts
        if callable(texts):
            text = texts(req)
        else:
            if self._text_index >= len(texts):
                raise LlmError("INVALID_OUTPUT", "FakeLlm: no scripted text response left")
            text = texts[self._text_index]
            self._text_index += 1
        return GenerateTextResult(text=text, usage=_USAGE)
