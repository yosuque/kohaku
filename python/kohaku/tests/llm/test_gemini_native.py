"""Tests for the Gemini (google-genai) native adapter.

Injects GeminiTransport / GeminiStreamTransport to control it deterministically (does not call the real API).
Gemini's structured output uses the text path that returns a JSON string via response_json_schema, so it is nearly
identical to openai_compat. This verifies channel routing (presence of response_schema) / auto fallback / stream
accumulation / usage mapping / the CONFIG error when the SDK is not installed.
"""

from __future__ import annotations

import asyncio
import builtins
from collections import deque
from collections.abc import AsyncIterator

import pytest

from kohaku.llm import (
    GenerateObjectRequest,
    GenerateTextRequest,
    JsonSchema,
    LlmError,
    create_llm,
    supports_streaming,
)
from kohaku.llm.abort import AbortError, AbortSignal
from kohaku.llm.adapters.gemini_native import (
    GeminiRequest,
    GeminiResponse,
    GeminiStreamChunk,
    create_gemini_native_llm,
)
from kohaku.llm.env import resolve_llm_env
from kohaku.llm.port import LlmUsage
from kohaku.llm.retry import ApiCallError, RetryDeps

CONFIG = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "gemini", "KOHAKU_LLM_API_KEY": "k"})


async def _noop_sleep(ms: float, signal: AbortSignal) -> None:
    return None


DEPS = RetryDeps(sleep=_noop_sleep, now=lambda: 0.0, random=lambda: 0.5)

_JSON_SCHEMA_REQ = GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")


class FakeGeminiTransport:
    """A stub transport that routes to two channels (structured / text) based on the presence of response_schema."""

    def __init__(self) -> None:
        self.object_script: deque[GeminiResponse | BaseException] = deque()
        self.text_script: deque[GeminiResponse | BaseException] = deque()
        self.object_repeat: BaseException | GeminiResponse | None = None
        self.text_repeat: BaseException | GeminiResponse | None = None
        self.object_calls: list[GeminiRequest] = []
        self.text_calls: list[GeminiRequest] = []

    async def __call__(
        self, req: GeminiRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> GeminiResponse:
        if req.response_schema is not None:
            self.object_calls.append(req)
            if self.object_script:
                item = self.object_script.popleft()
            elif self.object_repeat is not None:
                item = self.object_repeat
            else:
                raise AssertionError("object script exhausted")
        else:
            self.text_calls.append(req)
            if self.text_script:
                item = self.text_script.popleft()
            elif self.text_repeat is not None:
                item = self.text_repeat
            else:
                raise AssertionError("text script exhausted")
        if isinstance(item, BaseException):
            raise item
        return item


def _ok_object(payload: str) -> GeminiResponse:
    return GeminiResponse(text=payload, usage=LlmUsage(input_tokens=5, output_tokens=6))


def _ok_text(text: str) -> GeminiResponse:
    return GeminiResponse(text=text, usage=LlmUsage(input_tokens=0, output_tokens=0))


def _api_error(*, is_retryable: bool, status_code: int) -> ApiCallError:
    return ApiCallError(
        f"api {status_code}", is_retryable=is_retryable, status_code=status_code, response_headers={}
    )


def test_native_json_schema_success() -> None:
    async def run() -> None:
        transport = FakeGeminiTransport()
        transport.object_script.append(_ok_object('{"ok": true}'))
        llm = create_gemini_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": True}
        assert r.model == CONFIG.model
        assert r.usage == LlmUsage(input_tokens=5, output_tokens=6)  # usage mapping
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0
        # The structured call carries response_json_schema (the raw JSON Schema is passed through).
        assert transport.object_calls[0].response_schema == {"type": "object"}

    asyncio.run(run())


def test_invalid_structured_output_falls_back_to_prompt_json() -> None:
    async def run() -> None:
        transport = FakeGeminiTransport()
        transport.object_repeat = _ok_object("not json")  # INVALID_OUTPUT
        transport.text_script.append(_ok_text('{"ok": 1}'))
        llm = create_gemini_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": 1}
        assert len(transport.object_calls) == 1  # no retry
        assert len(transport.text_calls) == 1

    asyncio.run(run())


def test_retryable_provider_retries_natively_without_prompt_fallback() -> None:
    async def run() -> None:
        transport = FakeGeminiTransport()
        transport.object_script.extend(
            [
                _api_error(is_retryable=True, status_code=503),
                _api_error(is_retryable=True, status_code=500),
                _ok_object('{"ok": true}'),
            ]
        )
        llm = create_gemini_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": True}
        assert len(transport.object_calls) == 3
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_retryable_provider_exhausted_fails_without_fallback() -> None:
    async def run() -> None:
        transport = FakeGeminiTransport()
        transport.object_repeat = _api_error(is_retryable=True, status_code=429)
        llm = create_gemini_native_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "PROVIDER"
        assert len(transport.object_calls) == 3
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_aborted_propagates_without_retry_or_fallback() -> None:
    async def run() -> None:
        transport = FakeGeminiTransport()
        transport.object_repeat = AbortError("abort")
        llm = create_gemini_native_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "ABORTED"
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_strict_mode_does_not_fall_back() -> None:
    async def run() -> None:
        cfg = resolve_llm_env(
            {"KOHAKU_LLM_PROVIDER": "gemini", "KOHAKU_LLM_API_KEY": "k", "KOHAKU_LLM_STRUCTURED_MODE": "strict"}
        )
        transport = FakeGeminiTransport()
        transport.object_repeat = _api_error(is_retryable=False, status_code=400)
        llm = create_gemini_native_llm(cfg, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "PROVIDER"
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_generate_text_maps_usage_and_retries() -> None:
    async def run() -> None:
        transport = FakeGeminiTransport()
        transport.text_script.extend(
            [_api_error(is_retryable=True, status_code=500), _ok_text("hi")]
        )
        llm = create_gemini_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_text(GenerateTextRequest(prompt="p"))
        assert r.text == "hi"
        assert len(transport.text_calls) == 2

    asyncio.run(run())


# --- stream_object contract (text-chunk streaming) ------------------------------


class FakeGeminiStreamTransport:
    """A stub streaming transport that streams the text-chunk sequence in order and appends aggregated usage at the end."""

    def __init__(self, deltas: list[str], usage: LlmUsage | None = None) -> None:
        self.deltas = deltas
        self.usage = usage if usage is not None else LlmUsage(input_tokens=7, output_tokens=8)
        self.calls: list[GeminiRequest] = []

    async def stream(
        self, req: GeminiRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[GeminiStreamChunk]:
        self.calls.append(req)
        for delta in self.deltas:
            yield GeminiStreamChunk(delta=delta)
        yield GeminiStreamChunk(usage=self.usage)


def test_stream_object_accumulates_partials_and_validates_final() -> None:
    async def run() -> None:
        seen: list[object] = []
        transport = FakeGeminiTransport()
        stream_transport = FakeGeminiStreamTransport(['{"components": [', '{"id": "a"}', "]}"])
        llm = create_gemini_native_llm(
            CONFIG, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert len(seen) >= 2
        assert seen[-1] == {"components": [{"id": "a"}]}
        assert result.object == {"components": [{"id": "a"}]}
        assert result.usage == stream_transport.usage
        assert len(stream_transport.calls) == 1
        assert stream_transport.calls[0].response_schema == {"type": "object"}
        assert len(transport.text_calls) == 0
        assert len(transport.object_calls) == 0

    asyncio.run(run())


def test_stream_object_without_stream_transport_falls_back_to_generate_object() -> None:
    async def run() -> None:
        seen: list[object] = []
        transport = FakeGeminiTransport()
        transport.object_script.append(_ok_object('{"ok": 9}'))
        llm = create_gemini_native_llm(CONFIG, transport=transport, deps=DEPS)
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert result.object == {"ok": 9}
        assert seen == []  # no partials (fail-open)
        assert len(transport.object_calls) == 1

    asyncio.run(run())


def test_stream_object_falls_back_to_prompt_on_invalid_structured_output() -> None:
    async def run() -> None:
        seen: list[object] = []
        transport = FakeGeminiTransport()
        transport.text_script.append(_ok_text('{"ok": 7}'))
        stream_transport = FakeGeminiStreamTransport(["not json at all"])
        llm = create_gemini_native_llm(
            CONFIG, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert result.object == {"ok": 7}
        assert len(stream_transport.calls) == 1
        assert len(transport.text_calls) == 1

    asyncio.run(run())


def test_create_llm_gemini_missing_sdk_raises_config(monkeypatch: pytest.MonkeyPatch) -> None:
    # When google-genai is not installed, a CONFIG error points the way (the default path = SDK-backed transport).
    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "google" or name.startswith("google."):
            raise ImportError("No module named 'google.genai'")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(LlmError) as exc:
        create_llm(resolve_llm_env({"KOHAKU_LLM_PROVIDER": "gemini", "KOHAKU_LLM_API_KEY": "k"}))
    assert exc.value.code == "CONFIG"
    assert "kohaku[gemini]" in str(exc.value)


def test_create_llm_rejects_unknown_provider() -> None:
    # Hard to reach, but directly configuring an unsupported provider yields a CONFIG error (the branch at the end of create_llm).
    from typing import cast

    from kohaku.llm.env import LlmConfig, LlmProvider, RetryPolicy

    cfg = LlmConfig(
        provider=cast("LlmProvider", "bogus"),
        model="m",
        api_key=None,
        base_url=None,
        temperature=0.0,
        max_output_tokens=10,
        structured_mode="auto",
        timeout_ms=1000,
        retry=RetryPolicy(max_retries=2, initial_delay_ms=250, backoff_factor=2.0, jitter=0.25),
    )
    with pytest.raises(LlmError) as exc:
        create_llm(cfg)
    assert exc.value.code == "CONFIG"
