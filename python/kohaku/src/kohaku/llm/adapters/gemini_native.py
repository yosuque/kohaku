"""Gemini (google-genai) native adapter.

Corresponds to TS's `@ai-sdk/google`, but Python uses the google-genai SDK directly. The skeleton (budget
expansion / signal/deadline / PROVIDER retry / auto fallback decision / prompt JSON / stream accumulation) is
centralized in `_base.StructuredLlmBase`, and this adapter implements only the provider-specific single call.

Structured output uses `response_mime_type="application/json"` + `response_json_schema` (raw JSON Schema). Since the
registry's presentation-schema conversion has already absorbed Gemini's lack of $ref support, the result of
schema_to_json_schema is passed through as-is (using the SDK's `response_json_schema` field that accepts a JSON
Schema). The response text (JSON string) is reconstructed/validated by `parse_native_text` (output uses the same
text path as openai).

Streaming accumulates the text chunks of generate_content_stream and reconstructs/notifies the cumulative partial
via `_base`'s `_accumulate_stream` (= reuse of `_parse_partial_json`).

The SDK (google-genai) uses the same **lazy import** style as the mcp extra. It is not required at module import; it
is imported only when building the default transport (a CONFIG error if not installed). Tests inject
`GeminiTransport` / `GeminiStreamTransport` to verify without calling the real API.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from ..abort import AbortSignal, TimeoutAbortError
from ..env import LlmConfig
from ..port import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextResult,
    LlmEffort,
    LlmError,
    LlmUsage,
    OnPartial,
    PromptParts,
    schema_to_json_schema,
)
from ..retry import ApiCallError, RetryDeps, default_retry_deps
from ._base import StructuredLlmBase, parse_native_text


@dataclass(frozen=True)
class GeminiRequest:
    """Input for a single generate_content call. If `response_schema` is None it is plain text; when set it is
    JSON structured output (response_mime_type=application/json + response_json_schema)."""

    model: str
    system: str | None
    prompt: str
    temperature: float
    max_tokens: int
    response_schema: dict[str, Any] | None


@dataclass(frozen=True)
class GeminiResponse:
    """The result of generate_content (the body text and used tokens)."""

    text: str
    usage: LlmUsage


class GeminiTransport(Protocol):
    """The abstraction of a generate_content call. The default is the google-genai SDK. Tests stub this to control it."""

    async def __call__(
        self, req: GeminiRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> GeminiResponse: ...


@dataclass(frozen=True)
class GeminiStreamChunk:
    """One chunk of streaming generate_content. delta is the text increment, usage only on the final chunk."""

    delta: str = ""
    usage: LlmUsage | None = None


class GeminiStreamTransport(Protocol):
    """The abstraction of streaming generate_content (optional). If not injected, stream_object falls back to generate_object."""

    def stream(
        self, req: GeminiRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[GeminiStreamChunk]: ...


class GeminiNativeLlm(StructuredLlmBase):
    """An LlmPort implementation that calls the google-genai SDK using response_json_schema."""

    def __init__(
        self,
        config: LlmConfig,
        transport: GeminiTransport,
        retry_deps: RetryDeps,
        stream_transport: GeminiStreamTransport | None = None,
    ) -> None:
        super().__init__(config, retry_deps)
        self._transport = transport
        self._stream_transport = stream_transport

    def _can_stream_native(self) -> bool:
        return self._stream_transport is not None

    async def _structured_once(
        self,
        req: GenerateObjectRequest,
        max_output_tokens: int,
        signal: AbortSignal,
        deadline: float,
    ) -> GenerateObjectResult:
        config = self._config
        signal.throw_if_aborted()
        greq = GeminiRequest(
            model=config.model,
            system=req.system,
            prompt=req.prompt,
            temperature=req.temperature if req.temperature is not None else config.temperature,
            max_tokens=max_output_tokens,
            response_schema=schema_to_json_schema(req.schema),
        )
        resp = await self._transport(greq, timeout_ms=self._remaining(deadline), signal=signal)
        obj = parse_native_text(req.schema, resp.text, config)
        return GenerateObjectResult(object=obj, usage=resp.usage, model=config.model)

    async def _text_once(
        self,
        system: str | None,
        prompt: str,
        temperature: float,
        max_tokens: int,
        signal: AbortSignal,
        deadline: float,
        prompt_parts: PromptParts | None = None,  # noqa: ARG002 — Gemini already does automatic prefix
        # caching; this adapter has no explicit cache_control equivalent to act on.
        effort: LlmEffort | None = None,  # noqa: ARG002 — no equivalent effort-*level* option exists in
        # the installed google-genai SDK (only a numeric thinkingConfig.thinkingBudget, a different unit),
        # so `effort` is silently ignored for this provider (matches TS's adapters/ai-sdk.ts).
    ) -> GenerateTextResult:
        config = self._config
        signal.throw_if_aborted()
        greq = GeminiRequest(
            model=config.model,
            system=system,
            prompt=prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            response_schema=None,
        )
        resp = await self._transport(greq, timeout_ms=self._remaining(deadline), signal=signal)
        return GenerateTextResult(text=resp.text, usage=resp.usage)

    async def _stream_structured_once(
        self,
        req: GenerateObjectRequest,
        on_partial: OnPartial,
        max_output_tokens: int,
        signal: AbortSignal,
        deadline: float,
    ) -> GenerateObjectResult:
        config = self._config
        assert self._stream_transport is not None
        signal.throw_if_aborted()
        greq = GeminiRequest(
            model=config.model,
            system=req.system,
            prompt=req.prompt,
            temperature=req.temperature if req.temperature is not None else config.temperature,
            max_tokens=max_output_tokens,
            response_schema=schema_to_json_schema(req.schema),
        )

        async def _deltas() -> AsyncIterator[tuple[str, LlmUsage | None]]:
            assert self._stream_transport is not None
            async for chunk in self._stream_transport.stream(
                greq, timeout_ms=self._remaining(deadline), signal=signal
            ):
                yield chunk.delta, chunk.usage

        return await self._accumulate_stream(req, on_partial, _deltas())


def create_gemini_native_llm(
    config: LlmConfig,
    *,
    transport: GeminiTransport | None = None,
    stream_transport: GeminiStreamTransport | None = None,
    deps: RetryDeps | None = None,
) -> GeminiNativeLlm:
    """Build the Gemini native adapter. If `transport` is not given, lazily import the google-genai SDK.

    Test injection (passing a transport) does not require the SDK. On the default path, build the SDK-backed
    transport and stream transport (a CONFIG error if the SDK is not installed).
    """
    retry_deps = deps if deps is not None else default_retry_deps
    if transport is not None:
        return GeminiNativeLlm(config, transport, retry_deps, stream_transport)
    resolved_transport, resolved_stream = _build_sdk_transports(config)
    resolved_stream = stream_transport if stream_transport is not None else resolved_stream
    return GeminiNativeLlm(config, resolved_transport, retry_deps, resolved_stream)


def _build_sdk_transports(config: LlmConfig) -> tuple[GeminiTransport, GeminiStreamTransport]:
    try:
        from google import genai
        from google.genai import types
    except ImportError as err:
        raise LlmError(
            "CONFIG",
            'provider "gemini" requires the google-genai SDK. '
            "Run `pip install 'kohaku-ui[gemini]'`.",
        ) from err

    client_kwargs: dict[str, Any] = {"api_key": config.api_key or "not-required"}
    if config.base_url:
        client_kwargs["http_options"] = types.HttpOptions(base_url=config.base_url)
    client = genai.Client(**client_kwargs)
    return _SdkTransport(client, config), _SdkStreamTransport(client, config)


def _build_config(req: GeminiRequest, timeout_ms: float) -> Any:
    """Build a GenerateContentConfig. Only when response_schema is set does it become JSON structured output."""
    from google.genai import types

    # HttpOptions.timeout is in milliseconds. Cap it at the remaining budget to cut off an unresponsive stall within budget.
    config_kwargs: dict[str, Any] = {
        "temperature": req.temperature,
        "max_output_tokens": req.max_tokens,
        "http_options": types.HttpOptions(timeout=int(max(1.0, timeout_ms))),
    }
    if req.system is not None:
        config_kwargs["system_instruction"] = req.system
    if req.response_schema is not None:
        config_kwargs["response_mime_type"] = "application/json"
        # The registry's schema conversion has already absorbed the lack of $ref support, so pass the raw JSON Schema through.
        config_kwargs["response_json_schema"] = req.response_schema
    return types.GenerateContentConfig(**config_kwargs)


def _usage_of(usage_metadata: Any) -> LlmUsage:
    if usage_metadata is None:
        return LlmUsage(input_tokens=0, output_tokens=0)
    return LlmUsage(
        input_tokens=int(getattr(usage_metadata, "prompt_token_count", 0) or 0),
        output_tokens=int(getattr(usage_metadata, "candidates_token_count", 0) or 0),
    )


def _is_timeout(err: BaseException) -> bool:
    """Whether this is an httpx timeout-family exception (decided by class name; classified as ABORTED)."""
    return "Timeout" in type(err).__name__


class _SdkTransport:
    """The default google-genai SDK-backed transport (non-streaming). Maps SDK errors to ApiCallError /
    TimeoutAbortError so they ride the llm layer's retry / classification."""

    def __init__(self, client: Any, config: LlmConfig) -> None:
        self._client = client
        self._config = config

    async def __call__(
        self, req: GeminiRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> GeminiResponse:
        from google.genai import errors as genai_errors

        signal.throw_if_aborted()
        cfg = _build_config(req, timeout_ms)
        try:
            resp = await self._client.aio.models.generate_content(
                model=req.model, contents=req.prompt, config=cfg
            )
        except genai_errors.APIError as err:
            status = int(getattr(err, "code", 0) or 0)
            retryable = status == 429 or status >= 500
            raise ApiCallError(
                f"HTTP {status}: {str(err)[:200]}",
                is_retryable=retryable,
                status_code=status or None,
            ) from err
        except Exception as err:  # noqa: BLE001 — map the SDK's lower-layer (httpx) timeout/connection errors
            if _is_timeout(err):
                raise TimeoutAbortError(f"request timed out: {err}") from err
            # Everything else (network errors) is made retryable as a transient PROVIDER.
            raise ApiCallError(str(err), is_retryable=True) from err
        return GeminiResponse(
            text=getattr(resp, "text", None) or "",
            usage=_usage_of(getattr(resp, "usage_metadata", None)),
        )


class _SdkStreamTransport:
    """The default google-genai SDK-backed streaming transport. Streams text chunks as the delta to accumulate,
    and appends one aggregated usage chunk at the end."""

    def __init__(self, client: Any, config: LlmConfig) -> None:
        self._client = client
        self._config = config

    async def stream(
        self, req: GeminiRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[GeminiStreamChunk]:
        from google.genai import errors as genai_errors

        signal.throw_if_aborted()
        cfg = _build_config(req, timeout_ms)
        input_tokens = 0
        output_tokens = 0
        try:
            event_stream = await self._client.aio.models.generate_content_stream(
                model=req.model, contents=req.prompt, config=cfg
            )
            async for chunk in event_stream:
                usage_metadata = getattr(chunk, "usage_metadata", None)
                if usage_metadata is not None:
                    usage = _usage_of(usage_metadata)
                    # The cumulative count is last-wins (does not overwrite with 0).
                    input_tokens = usage.input_tokens or input_tokens
                    output_tokens = usage.output_tokens or output_tokens
                text = getattr(chunk, "text", None) or ""
                if text:
                    yield GeminiStreamChunk(delta=text)
            yield GeminiStreamChunk(
                usage=LlmUsage(input_tokens=input_tokens, output_tokens=output_tokens)
            )
        except genai_errors.APIError as err:
            status = int(getattr(err, "code", 0) or 0)
            retryable = status == 429 or status >= 500
            raise ApiCallError(
                f"HTTP {status}: {str(err)[:200]}",
                is_retryable=retryable,
                status_code=status or None,
            ) from err
        except Exception as err:  # noqa: BLE001 — map the SDK's lower-layer (httpx) timeout/connection errors
            if _is_timeout(err):
                raise TimeoutAbortError(f"request timed out: {err}") from err
            raise ApiCallError(str(err), is_retryable=True) from err
