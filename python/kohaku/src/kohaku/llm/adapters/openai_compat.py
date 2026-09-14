"""OpenAI-compatible Chat Completions API adapter (re-implements the behavior of ai-sdk.ts by calling httpx directly).

The TS version depends on the Vercel AI SDK, so rather than porting it as-is, its "behavior" is ported:
- structured-output mode auto = native JSON Schema mode → fall back to prompt JSON on failure
  (strict is always native / prompt is always prompt JSON)
- retry limited to PROVIDER (429/5xx) (retry.py) / the timeout is never exceeded across a single call
- error classification (PROVIDER / ABORTED / INVALID_OUTPUT)

Target providers: openai / ollama / llama.cpp (all via /v1/chat/completions with response_format=json_schema).
Anthropic (claude) is handled by adapters/anthropic_native.py, Gemini by adapters/gemini_native.py.

The skeleton (budget expansion / signal/deadline / retry / auto fallback / prompt JSON / stream accumulation) is
centralized in `_base.StructuredLlmBase`, and this adapter implements only the provider-specific single call.

The HTTP layer is injectable as `ChatTransport`; the default lazily imports httpx at construction time (module
import and tests pass even without httpx installed, and it becomes required only when actually calling a real LLM).
"""

from __future__ import annotations

import json
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
    LlmPort,
    LlmUsage,
    OnPartial,
    PromptParts,
    schema_to_json_schema,
)
from ..retry import (
    ApiCallError,
    RetryDeps,
    default_retry_deps,
)
from ._base import (
    StructuredLlmBase,
    close_open_structures,
    parse_native_text,
    parse_partial_json,
)

# Backward compatibility (old test reference names). Alias imports are treated as non-public by mypy's
# no_implicit_reexport, so re-export via explicit assignment.
_close_open_structures = close_open_structures
_parse_partial_json = parse_partial_json


class ChatRequest:
    """Input for a single chat.completions call. If `response_format` is None it is plain text.

    `reasoning_effort` (port of TS's `resolveProviderOptions`'s `{ openai: { reasoningEffort } }` /
    `{ openaiCompatible: { reasoningEffort } }` — both AI SDK providers forward to the same wire field, so
    this adapter (shared by openai/ollama/llama) needs only the one field) is sent as-is as the request
    body's `reasoning_effort` when set (verified against the installed `@ai-sdk/openai` and
    `@ai-sdk/openai-compatible`'s own request-building code, which both write `reasoning_effort:` at the
    top level of the chat.completions body). None when unset — no key added at all, byte-identical to a
    call made before this field existed. Whether the endpoint actually honors it depends on the endpoint
    (vLLM/llama.cpp-style OpenAI-compatible servers commonly do; a plain endpoint that does not recognize it
    simply ignores the extra request field).
    """

    def __init__(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        max_tokens: int,
        response_format: dict[str, Any] | None,
        reasoning_effort: LlmEffort | None = None,
    ) -> None:
        self.model = model
        self.messages = messages
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.response_format = response_format
        self.reasoning_effort = reasoning_effort


class ChatResponse:
    """The result of chat.completions (the body text and used tokens)."""

    def __init__(self, *, text: str, usage: LlmUsage) -> None:
        self.text = text
        self.usage = usage


class ChatTransport(Protocol):
    """The abstraction of the HTTP layer. The default is httpx. Tests stub this to control it deterministically."""

    async def __call__(
        self, req: ChatRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> ChatResponse: ...


@dataclass(frozen=True)
class ChatStreamChunk:
    """One chunk of streaming chat.completions.

    delta is the text increment to accumulate. usage is present only on the final chunk (OpenAI-compatible SSE
    sends usage at the end with stream_options.include_usage=true).
    """

    delta: str = ""
    usage: LlmUsage | None = None


class StreamingChatTransport(Protocol):
    """An HTTP layer with SSE streaming support (optional). Reads chat.completions with stream:true.

    Used for native structured-output streaming. If not injected, stream_object falls back to generate_object
    with no partials (the same fail-open as TS's "prompt JSON mode does not stream").
    """

    def stream(
        self, req: ChatRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[ChatStreamChunk]: ...


def _messages(system: str | None, prompt: str) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if system is not None:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return messages


def _json_schema_format(req: GenerateObjectRequest) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": req.schema_name if req.schema_name is not None else "response",
            "schema": schema_to_json_schema(req.schema),
            "strict": True,
        },
    }


class OpenAiCompatLlm(StructuredLlmBase):
    """An LlmPort implementation that calls OpenAI-compatible Chat Completions."""

    def __init__(
        self,
        config: LlmConfig,
        transport: ChatTransport,
        retry_deps: RetryDeps,
        stream_transport: StreamingChatTransport | None = None,
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
        chat = ChatRequest(
            model=config.model,
            messages=_messages(req.system, req.prompt),
            temperature=req.temperature if req.temperature is not None else config.temperature,
            max_tokens=max_output_tokens,
            response_format=_json_schema_format(req),
            reasoning_effort=req.effort,
        )
        resp = await self._transport(chat, timeout_ms=self._remaining(deadline), signal=signal)
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
        prompt_parts: PromptParts | None = None,  # noqa: ARG002 — OpenAI-compatible endpoints already do
        # automatic prefix caching; this adapter has no explicit cache_control equivalent to act on.
        effort: LlmEffort | None = None,
    ) -> GenerateTextResult:
        signal.throw_if_aborted()
        chat = ChatRequest(
            model=self._config.model,
            messages=_messages(system, prompt),
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=None,
            reasoning_effort=effort,
        )
        resp = await self._transport(chat, timeout_ms=self._remaining(deadline), signal=signal)
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
        chat = ChatRequest(
            model=config.model,
            messages=_messages(req.system, req.prompt),
            temperature=req.temperature if req.temperature is not None else config.temperature,
            max_tokens=max_output_tokens,
            response_format=_json_schema_format(req),
            reasoning_effort=req.effort,
        )

        async def _deltas() -> AsyncIterator[tuple[str, LlmUsage | None]]:
            assert self._stream_transport is not None
            async for chunk in self._stream_transport.stream(
                chat, timeout_ms=self._remaining(deadline), signal=signal
            ):
                yield chunk.delta, chunk.usage

        return await self._accumulate_stream(req, on_partial, _deltas())


def create_openai_compat_llm(
    config: LlmConfig,
    *,
    transport: ChatTransport | None = None,
    stream_transport: StreamingChatTransport | None = None,
    deps: RetryDeps | None = None,
) -> LlmPort:
    """Build the OpenAI-compatible adapter. If `transport` is not given, lazily import httpx to build the default.

    Streaming (stream_object) is enabled only when a `stream_transport` is present. On the default (transport not
    injected) httpx path, a stream-capable transport is also built. If a transport is test-injected but no
    stream_transport is passed, streaming is disabled (stream_object falls back to generate_object).
    """
    retry_deps = deps if deps is not None else default_retry_deps
    if transport is not None:
        return OpenAiCompatLlm(config, transport, retry_deps, stream_transport)
    resolved_transport = _build_httpx_transport(config)
    resolved_stream = (
        stream_transport if stream_transport is not None else _build_httpx_stream_transport(config)
    )
    return OpenAiCompatLlm(config, resolved_transport, retry_deps, resolved_stream)


def _build_httpx_transport(config: LlmConfig) -> ChatTransport:
    try:
        import httpx
    except ImportError as err:
        raise RuntimeError(
            "The OpenAI-compatible adapter requires httpx. Run `pip install 'kohaku-ui[llm]'`."
        ) from err

    base_url = config.base_url or (
        "https://api.openai.com/v1" if config.provider == "openai" else None
    )
    if not base_url:
        raise LlmError("CONFIG", f'provider "{config.provider}" requires a base_url')
    api_key = config.api_key or "not-required"

    async def transport(req: ChatRequest, *, timeout_ms: float, signal: AbortSignal) -> ChatResponse:
        # Check for abort before the call. An abort during execution is caught by httpx's request timeout (remaining budget).
        signal.throw_if_aborted()
        body: dict[str, Any] = {
            "model": req.model,
            "messages": req.messages,
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        }
        if req.response_format is not None:
            body["response_format"] = req.response_format
        if req.reasoning_effort is not None:
            body["reasoning_effort"] = req.reasoning_effort
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        timeout_s = max(0.1, timeout_ms / 1000.0)
        try:
            async with httpx.AsyncClient(base_url=base_url, timeout=timeout_s) as client:
                http_resp = await client.post("/chat/completions", json=body, headers=headers)
        except httpx.TimeoutException as err:
            # Exceeding the remaining budget = timeout. Classify as ABORTED and do not retry.
            raise TimeoutAbortError(f"request timed out: {err}") from err
        except httpx.HTTPError as err:
            # Network errors are considered transient and made retryable.
            raise ApiCallError(str(err), is_retryable=True, url=base_url) from err
        if http_resp.status_code >= 400:
            retryable = http_resp.status_code == 429 or http_resp.status_code >= 500
            raise ApiCallError(
                f"HTTP {http_resp.status_code}: {http_resp.text[:200]}",
                is_retryable=retryable,
                status_code=http_resp.status_code,
                response_headers={k.lower(): v for k, v in http_resp.headers.items()},
                url=base_url,
            )
        data = http_resp.json()
        text = data["choices"][0]["message"].get("content") or ""
        usage_raw = data.get("usage") or {}
        usage = LlmUsage(
            input_tokens=int(usage_raw.get("prompt_tokens") or 0),
            output_tokens=int(usage_raw.get("completion_tokens") or 0),
        )
        return ChatResponse(text=text, usage=usage)

    return transport


def _build_httpx_stream_transport(config: LlmConfig) -> StreamingChatTransport:
    """Build a StreamingChatTransport that reads SSE with stream:true over httpx (for the default httpx path)."""
    try:
        import httpx
    except ImportError as err:
        raise RuntimeError(
            "The OpenAI-compatible adapter requires httpx. Run `pip install 'kohaku-ui[llm]'`."
        ) from err

    resolved = config.base_url or (
        "https://api.openai.com/v1" if config.provider == "openai" else None
    )
    if not resolved:
        raise LlmError("CONFIG", f'provider "{config.provider}" requires a base_url')
    # A nested class's method does not inherit the outer scope's type narrowing, so bind it to a str-confirmed
    # local and capture that in the closure (base_url is str, not None).
    base_url: str = resolved
    api_key = config.api_key or "not-required"

    class _HttpxStreamTransport:
        async def stream(
            self, req: ChatRequest, *, timeout_ms: float, signal: AbortSignal
        ) -> AsyncIterator[ChatStreamChunk]:
            signal.throw_if_aborted()
            body: dict[str, Any] = {
                "model": req.model,
                "messages": req.messages,
                "temperature": req.temperature,
                "max_tokens": req.max_tokens,
                "stream": True,
                # Include a usage chunk at the end (OpenAI-compatible stream_options).
                "stream_options": {"include_usage": True},
            }
            if req.response_format is not None:
                body["response_format"] = req.response_format
            if req.reasoning_effort is not None:
                body["reasoning_effort"] = req.reasoning_effort
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            timeout_s = max(0.1, timeout_ms / 1000.0)
            try:
                async with httpx.AsyncClient(base_url=base_url, timeout=timeout_s) as client:
                    async with client.stream(
                        "POST", "/chat/completions", json=body, headers=headers
                    ) as http_resp:
                        if http_resp.status_code >= 400:
                            await http_resp.aread()
                            retryable = (
                                http_resp.status_code == 429 or http_resp.status_code >= 500
                            )
                            raise ApiCallError(
                                f"HTTP {http_resp.status_code}: {http_resp.text[:200]}",
                                is_retryable=retryable,
                                status_code=http_resp.status_code,
                                response_headers={
                                    k.lower(): v for k, v in http_resp.headers.items()
                                },
                                url=base_url,
                            )
                        async for line in http_resp.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            payload = line[len("data:") :].strip()
                            if payload == "" or payload == "[DONE]":
                                continue
                            try:
                                event = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            choices = event.get("choices") or []
                            delta = ""
                            if choices:
                                delta = (choices[0].get("delta") or {}).get("content") or ""
                            usage_raw = event.get("usage")
                            usage = (
                                LlmUsage(
                                    input_tokens=int(usage_raw.get("prompt_tokens") or 0),
                                    output_tokens=int(usage_raw.get("completion_tokens") or 0),
                                )
                                if isinstance(usage_raw, dict)
                                else None
                            )
                            if delta != "" or usage is not None:
                                yield ChatStreamChunk(delta=delta, usage=usage)
            except httpx.TimeoutException as err:
                raise TimeoutAbortError(f"request timed out: {err}") from err
            except httpx.HTTPError as err:
                raise ApiCallError(str(err), is_retryable=True, url=base_url) from err

    return _HttpxStreamTransport()
