"""Shared generation orchestration and JSON helpers for the native / OpenAI-compatible adapters.

The three adapters `OpenAiCompatLlm` / `AnthropicNativeLlm` / `GeminiNativeLlm` differ only in the
provider-specific "single call"; the rest of the skeleton is entirely shared:

- output-budget (time / tokens) expansion via `output_budget_factor`
- assembly of the signal (caller abort + timeout) / deadline (one call = at most timeout_ms)
- jitter-added exponential backoff retry limited to PROVIDER (429/5xx) (`with_provider_retry`)
- structured_mode auto fallback decision (strict immediate / ABORTED immediate / retryable PROVIDER
  exhausted immediate / otherwise a single prompt JSON attempt)
- prompt JSON fallback (`_generate_via_prompt`) with JSON extraction and validation
- cumulative partial reconstruction for native structured streaming (reuse of `parse_partial_json`)

This skeleton is centralized in `StructuredLlmBase`, and subclasses implement only these three primitives:
`_structured_once` (a single native structured call) / `_text_once` (a single text generation) /
`_stream_structured_once` (a single native structured stream; optional). Error mapping (LlmError:
CONFIG / INVALID_OUTPUT / PROVIDER / ABORTED) is also shared here (`wrap_error`).
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import AsyncIterator
from typing import Any

from ..abort import AbortError, AbortSignal
from ..env import LlmConfig
from ..port import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextRequest,
    GenerateTextResult,
    LlmEffort,
    LlmError,
    LlmErrorCode,
    LlmUsage,
    OnPartial,
    PromptParts,
    SchemaInput,
    SchemaValidationError,
    is_validating_schema,
    schema_to_json_schema,
    validate_against_schema,
)
from ..retry import (
    RetryDeps,
    _round_half_up,
    is_retryable_provider_error,
    with_provider_retry,
)

# --- Shared JSON helpers (relocated from the old openai_compat private functions) ----------------------


def normalize_budget_factor(factor: float | None) -> float:
    """Normalize the output-budget multiplier. Invalid values (None / non-finite / less than 1) fall back to 1."""
    if factor is None or isinstance(factor, bool):
        return 1.0
    if not math.isfinite(factor) or factor < 1:
        return 1.0
    return float(factor)


def wrap_error(cause: BaseException, config: LlmConfig) -> LlmError:
    """Map an arbitrary exception to an LlmError. LlmError passes through, AbortError is ABORTED, others are PROVIDER."""
    if isinstance(cause, LlmError):
        return cause
    code: LlmErrorCode = "ABORTED" if isinstance(cause, AbortError) else "PROVIDER"
    return LlmError(
        code,
        f"[{config.provider}/{config.model}] {cause}",
        provider=config.provider,
        model_id=config.model,
        cause=cause,
    )


def extract_json(text: str) -> str:
    """Strip code fences and surrounding text to extract the JSON body."""
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    body = (fenced.group(1) if fenced is not None else text).strip()
    # First try parsing the whole thing directly. In the normal case where the model output only JSON as instructed, this settles it here.
    try:
        json.loads(body)
        return body
    except json.JSONDecodeError:
        pass
    # Fallback when text is mixed in before/after. Use whichever of `{` and `[` appears earlier as the start,
    # and slice up to the last position of the corresponding closing bracket (handles both objects and arrays).
    obj_start = body.find("{")
    arr_start = body.find("[")
    use_array = arr_start >= 0 and (obj_start < 0 or arr_start < obj_start)
    start = arr_start if use_array else obj_start
    end = body.rfind("]") if use_array else body.rfind("}")
    return body[start : end + 1] if (start >= 0 and end > start) else body


def close_open_structures(prefix: str) -> str | None:
    """Best-effort closing of unclosed structures (strings, objects, arrays) by appending closing brackets.

    - A prefix cut off mid-string returns None (closing it would still break on a missing key/value, so the
      caller tries a shorter prefix).
    - A single trailing extra `,` (dangling comma) is dropped. Immediately after `:` (no value) returns None.
    - Over-closing a bracket (a `}` / `]` with an empty stack) returns None (broken output).
    """
    stack: list[str] = []
    in_string = False
    escape = False
    for ch in prefix:
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            stack.append("}")
        elif ch == "[":
            stack.append("]")
        elif ch in ("}", "]"):
            if not stack:
                return None
            stack.pop()
    if in_string:
        return None
    body = prefix.rstrip()
    if body.endswith(","):
        body = body[:-1].rstrip()
    if body.endswith(":"):
        return None
    return body + "".join(reversed(stack))


def parse_partial_json(text: str) -> Any | None:
    """Reconstruct the **longest valid JSON prefix** from the LLM's incomplete cumulative output (parse & heal).

    Called on each increment of native structured-output streaming; the cumulative partial is notified only on
    success. The healing can be simple (an incomplete trailing element is assumed to be dropped by the consumer =
    build_provisional_spec). If it cannot be reconstructed, returns None (no partial for that increment).
    """
    stripped = text.strip()
    if stripped == "":
        return None
    # The normal case where the whole thing is directly valid settles here (e.g. the final increment after completion).
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    # Shrinking from the end, look for the "longest prefix that becomes valid once closing brackets are added".
    # partial is a small JSON, so brute force is sufficient (conflating also bounds the frequency).
    for end in range(len(stripped), 0, -1):
        completed = close_open_structures(stripped[:end])
        if completed is None:
            continue
        try:
            return json.loads(completed)
        except json.JSONDecodeError:
            continue
    return None


def validate_native_object(schema: SchemaInput, obj: object, config: LlmConfig) -> Any:
    """Validate an already-parsed native structured object, if it is a validating schema.

    Anthropic's tool-use returns input as a dict, so it is validated through this path (no json.loads needed).
    Failure is INVALID_OUTPUT (in auto this triggers the prompt JSON fallback).
    """
    if is_validating_schema(schema):
        try:
            return validate_against_schema(schema, obj)
        except SchemaValidationError as err:
            raise LlmError(
                "INVALID_OUTPUT",
                f"structured output does not match schema: {str(err)[:300]}",
                provider=config.provider,
                model_id=config.model,
            ) from err
    return obj


def parse_native_text(schema: SchemaInput, text: str, config: LlmConfig) -> Any:
    """Reconstruct native structured-output text (a JSON string) and validate it, if it is a validating schema.

    Used by OpenAI-compatible (response_format) / Gemini (response_json_schema) / the full-text validation after
    a stream completes. Failure is INVALID_OUTPUT.
    """
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as err:
        raise LlmError(
            "INVALID_OUTPUT",
            "structured output is not valid JSON",
            provider=config.provider,
            model_id=config.model,
        ) from err
    return validate_native_object(schema, obj, config)


# --- Shared orchestration core --------------------------------------------------------


class StructuredLlmBase:
    """The shared orchestration core of LlmPort.

    Subclasses implement only the provider-specific three primitives (`_structured_once` / `_text_once` /
    `_stream_structured_once`) and `_can_stream_native`. Budget expansion, signal/deadline, PROVIDER retry, the
    auto fallback decision, and the prompt JSON fallback are all handled here.
    """

    def __init__(self, config: LlmConfig, retry_deps: RetryDeps) -> None:
        self.provider: str = config.provider
        self.model_id: str = config.model
        self._config = config
        self._retry_deps = retry_deps

    def _remaining(self, deadline: float) -> float:
        return max(0.0, deadline - self._retry_deps.now())

    # --- Provider-specific primitives (implemented by subclasses) -----------------------------------

    async def _structured_once(
        self,
        req: GenerateObjectRequest,
        max_output_tokens: int,
        signal: AbortSignal,
        deadline: float,
    ) -> GenerateObjectResult:
        """A single native structured call (retry / fallback are handled by the caller)."""
        raise NotImplementedError

    async def _text_once(
        self,
        system: str | None,
        prompt: str,
        temperature: float,
        max_tokens: int,
        signal: AbortSignal,
        deadline: float,
        prompt_parts: PromptParts | None = None,
        effort: LlmEffort | None = None,
    ) -> GenerateTextResult:
        """A single text generation (the shared primitive of generate_text and the prompt JSON fallback).

        `prompt_parts` (port of TS's baseCallOptions/resolvePromptInput split) is passed only from
        `generate_text`'s real call — never from `_generate_via_prompt`'s schema-appended fallback prompt,
        which does not satisfy the `cacheable + rest == prompt` invariant against its own composed prompt
        (matching TS: `generateViaPrompt` overrides `prompt` without threading `promptParts`). Adapters with
        no caching mechanism (openai_compat, gemini_native) accept and ignore it; only anthropic_native acts
        on it, and only when `LlmConfig.prompt_cache` is set.

        `effort` (port of TS's `baseCallOptions`/`resolveProviderOptions`), unlike `prompt_parts`, is passed
        from **both** call sites — `generate_text`'s real call and `_generate_via_prompt`'s fallback — since
        TS's `generateViaPrompt` keeps spreading the caller's original `req` (which still carries `effort`)
        even though it overwrites `prompt` itself. Each adapter wires it to its own provider's reasoning-effort
        field (see `anthropic_native.py` / `openai_compat.py`); `gemini_native.py` accepts and ignores it (no
        matching option).
        """
        raise NotImplementedError

    def _can_stream_native(self) -> bool:
        """Whether native structured streaming is usable in this configuration (fall back to generate_object if not)."""
        return False

    async def _stream_structured_once(
        self,
        req: GenerateObjectRequest,
        on_partial: OnPartial,
        max_output_tokens: int,
        signal: AbortSignal,
        deadline: float,
    ) -> GenerateObjectResult:
        """A single native structured stream (cumulative partial notification + full-text validation on completion)."""
        raise NotImplementedError

    # --- Shared helper: stream accumulation ----------------------------------------------------

    async def _accumulate_stream(
        self,
        req: GenerateObjectRequest,
        on_partial: OnPartial,
        deltas: AsyncIterator[tuple[str, LlmUsage | None]],
    ) -> GenerateObjectResult:
        """Accumulate a stream of string deltas, healing partial JSON on each increment to notify on_partial, then
        validate the full text through the normal path once the stream completes (streaming shared by all providers).

        with_provider_retry retries this whole thunk, so on a retry the partials are resent from the beginning
        (contract: the consumer rebuilds from scratch every time). A throw from on_partial is swallowed.
        """
        config = self._config
        accumulated = ""
        usage = LlmUsage(input_tokens=0, output_tokens=0)
        async for delta, chunk_usage in deltas:
            if chunk_usage is not None:
                usage = chunk_usage
            if delta == "":
                continue
            accumulated += delta
            partial = parse_partial_json(accumulated)
            if partial is None:
                continue
            try:
                on_partial(partial)
            except Exception:  # noqa: BLE001,S110 — a consumer exception must not break generation (contract)
                pass
        obj = parse_native_text(req.schema, accumulated, config)
        return GenerateObjectResult(object=obj, usage=usage, model=config.model)

    # --- Orchestration (shared) ---------------------------------------------------

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        config = self._config
        mode = config.structured_mode
        # Expand the output budget (time / tokens) by output_budget_factor (default 1 = same as before).
        # max_output_tokens respects the caller's explicit value if given, and is not multiplied.
        factor = normalize_budget_factor(req.output_budget_factor)
        timeout_ms = config.timeout_ms * factor
        max_output_tokens = (
            req.max_output_tokens
            if req.max_output_tokens is not None
            else _round_half_up(config.max_output_tokens * factor)
        )
        # The signal is created once at the entry point and shared by the native attempt and the auto-fallback
        # prompt attempt. Creating it per attempt would create a new timeout and could linger for up to 2×timeout_ms.
        timeout_sig = AbortSignal.timeout(timeout_ms)
        signal = (
            AbortSignal.any([req.abort, timeout_sig]) if req.abort is not None else timeout_sig
        )
        deadline = self._retry_deps.now() + timeout_ms
        try:
            if mode != "prompt":
                try:
                    return await with_provider_retry(
                        lambda: self._structured_once(req, max_output_tokens, signal, deadline),
                        policy=config.retry,
                        signal=signal,
                        deadline=deadline,
                        deps=self._retry_deps,
                    )
                except asyncio.CancelledError:
                    # Task cancellation / client disconnect is not disguised as PROVIDER but re-raised immediately
                    # (proceeding to the prompt fallback would keep generating after disconnect and waste tokens).
                    raise
                except BaseException as cause:
                    wrapped = wrap_error(cause, config)
                    # strict fails immediately. Even auto propagates an abort (ABORTED) immediately (the shared
                    # signal is already aborted, so retrying via prompt is pointless).
                    if mode == "strict" or wrapped.code == "ABORTED":
                        raise wrapped from cause
                    # A failure after exhausting retries on a transient PROVIDER (429/5xx) is not resolved by the
                    # prompt mode of the same provider. Avoid the double spend of fallback × backoff and propagate immediately.
                    if wrapped.code == "PROVIDER" and is_retryable_provider_error(cause):
                        raise wrapped from cause
                    # auto: everything else (INVALID_OUTPUT / non-retryable PROVIDER = structured-output 400 etc.)
                    # is retried once with prompt JSON.
            return await self._generate_via_prompt(req, max_output_tokens, signal, deadline)
        finally:
            timeout_sig.cancel_timer()

    async def stream_object(
        self, req: GenerateObjectRequest, on_partial: OnPartial
    ) -> GenerateObjectResult:
        """Streaming structured-output generation. Budget / signal / deadline assembly is identical to generate_object
        (one call = at most timeout_ms). Streams only in native structured mode; under the prompt JSON fallback there
        are no partials (same contract as TS ai-sdk.ts's streamObject)."""
        config = self._config
        mode = config.structured_mode
        # When native structured streaming is not usable in this configuration (unsupported / prompt mode),
        # fall back to generate_object with no partials (same fail-open as TS).
        if not self._can_stream_native() or mode == "prompt":
            return await self.generate_object(req)

        factor = normalize_budget_factor(req.output_budget_factor)
        timeout_ms = config.timeout_ms * factor
        max_output_tokens = (
            req.max_output_tokens
            if req.max_output_tokens is not None
            else _round_half_up(config.max_output_tokens * factor)
        )
        timeout_sig = AbortSignal.timeout(timeout_ms)
        signal = (
            AbortSignal.any([req.abort, timeout_sig]) if req.abort is not None else timeout_sig
        )
        deadline = self._retry_deps.now() + timeout_ms
        try:
            try:
                return await with_provider_retry(
                    lambda: self._stream_structured_once(
                        req, on_partial, max_output_tokens, signal, deadline
                    ),
                    policy=config.retry,
                    signal=signal,
                    deadline=deadline,
                    deps=self._retry_deps,
                )
            except asyncio.CancelledError:
                raise
            except BaseException as cause:
                # The fallback decision is identical to generate_object (strict immediate / ABORTED immediate /
                # retryable PROVIDER exhausted immediate / otherwise auto falls back to prompt JSON).
                wrapped = wrap_error(cause, config)
                if mode == "strict" or wrapped.code == "ABORTED":
                    raise wrapped from cause
                if wrapped.code == "PROVIDER" and is_retryable_provider_error(cause):
                    raise wrapped from cause
            # Prompt JSON mode does not stream (no partial notifications = the best-effort part of the contract).
            return await self._generate_via_prompt(req, max_output_tokens, signal, deadline)
        finally:
            timeout_sig.cancel_timer()

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        config = self._config
        # The same budget expansion as generate_object (L2's raw HTML generation uses the generate_text path).
        factor = normalize_budget_factor(req.output_budget_factor)
        timeout_ms = config.timeout_ms * factor
        max_output_tokens = (
            req.max_output_tokens
            if req.max_output_tokens is not None
            else _round_half_up(config.max_output_tokens * factor)
        )
        timeout_sig = AbortSignal.timeout(timeout_ms)
        signal = (
            AbortSignal.any([req.abort, timeout_sig]) if req.abort is not None else timeout_sig
        )
        deadline = self._retry_deps.now() + timeout_ms
        try:
            result = await with_provider_retry(
                lambda: self._text_once(
                    req.system,
                    req.prompt,
                    req.temperature if req.temperature is not None else config.temperature,
                    max_output_tokens,
                    signal,
                    deadline,
                    prompt_parts=req.prompt_parts,
                    effort=req.effort,
                ),
                policy=config.retry,
                signal=signal,
                deadline=deadline,
                deps=self._retry_deps,
            )
            return GenerateTextResult(text=result.text, usage=result.usage)
        except asyncio.CancelledError:
            # Cancellation is not converted to PROVIDER but re-raised immediately (prevents generation continuing after disconnect).
            raise
        except BaseException as cause:
            raise wrap_error(cause, config) from cause
        finally:
            timeout_sig.cancel_timer()

    async def _generate_via_prompt(
        self,
        req: GenerateObjectRequest,
        max_output_tokens: int,
        signal: AbortSignal,
        deadline: float,
    ) -> GenerateObjectResult:
        """Prompt JSON mode: attach the schema to the prompt, generate plain text, extract the JSON, and (if it is a
        validating schema) validate it. An escape hatch for endpoints that lack structured output or are unstable."""
        config = self._config
        schema_json = json.dumps(schema_to_json_schema(req.schema), ensure_ascii=False)
        prompt = "\n\n".join(
            [
                req.prompt,
                "## Output format",
                "Output only a JSON object that strictly conforms to the following JSON Schema.",
                "Do not output any explanatory text, code fences, or any text other than the JSON.",
                schema_json,
            ]
        )
        try:
            result = await with_provider_retry(
                lambda: self._text_once(
                    req.system,
                    prompt,
                    req.temperature if req.temperature is not None else config.temperature,
                    max_output_tokens,
                    signal,
                    deadline,
                    effort=req.effort,
                ),
                policy=config.retry,
                signal=signal,
                deadline=deadline,
                deps=self._retry_deps,
            )
            text = extract_json(result.text)
            try:
                obj = json.loads(text)
            except json.JSONDecodeError as err:
                raise LlmError(
                    "INVALID_OUTPUT",
                    "prompt-mode output is not valid JSON",
                    provider=config.provider,
                    model_id=config.model,
                ) from err
            if is_validating_schema(req.schema):
                try:
                    parsed = validate_against_schema(req.schema, obj)
                except SchemaValidationError as err:
                    raise LlmError(
                        "INVALID_OUTPUT",
                        f"prompt-mode output does not match schema: {str(err)[:300]}",
                        provider=config.provider,
                        model_id=config.model,
                    ) from err
                return GenerateObjectResult(object=parsed, usage=result.usage, model=config.model)
            return GenerateObjectResult(object=obj, usage=result.usage, model=config.model)
        except LlmError:
            raise
        except asyncio.CancelledError:
            # Cancellation is not converted to PROVIDER but re-raised immediately (prevents generation continuing after disconnect).
            raise
        except BaseException as cause:
            raise wrap_error(cause, config) from cause
