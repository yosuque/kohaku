"""Tests for the OpenAI-compatible adapter (the ai-sdk-retry.test.ts scenarios as pytest).

Stubs the HTTP layer (ChatTransport) to control it deterministically. Corresponding to how TS replaces "ai"'s
generateObject / generateText with vi.mock, this routes to the "structured (object) channel" and the "text
(prompt / generate_text) channel" based on the presence of response_format. Does not call a real LLM.
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
from kohaku.llm.adapters.openai_compat import (
    ChatRequest,
    ChatResponse,
    ChatStreamChunk,
    _close_open_structures,
    _parse_partial_json,
    create_openai_compat_llm,
)
from kohaku.llm.env import resolve_llm_env
from kohaku.llm.port import LlmUsage
from kohaku.llm.retry import ApiCallError, RetryDeps

# config matching ai-sdk-retry.test.ts: ollama (OpenAI-compatible) + default retry (max2 / init250).
# sleep is immediate, now is fixed (with slack before the deadline), randomness is centered.
CONFIG = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "ollama"})


async def _noop_sleep(ms: float, signal: AbortSignal) -> None:
    return None


DEPS = RetryDeps(sleep=_noop_sleep, now=lambda: 0.0, random=lambda: 0.5)

_JSON_SCHEMA_REQ = GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")


class FakeTransport:
    """A stub transport that routes scripted responses to two channels based on the presence of response_format.

    Each channel's script elements are either a ChatResponse (success) or a BaseException (to raise).
    Setting `object_repeat` / `text_repeat` keeps raising that exception every time (equivalent to mockRejectedValue).
    """

    def __init__(self) -> None:
        self.object_script: deque[ChatResponse | BaseException] = deque()
        self.text_script: deque[ChatResponse | BaseException] = deque()
        self.object_repeat: BaseException | None = None
        self.text_repeat: BaseException | None = None
        self.object_calls: list[ChatRequest] = []
        self.text_calls: list[ChatRequest] = []

    async def __call__(
        self, req: ChatRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> ChatResponse:
        if req.response_format is not None:
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


def _ok_object(payload: str) -> ChatResponse:
    return ChatResponse(text=payload, usage=LlmUsage(input_tokens=1, output_tokens=2))


def _ok_text(text: str) -> ChatResponse:
    return ChatResponse(text=text, usage=LlmUsage(input_tokens=0, output_tokens=0))


def _api_error(*, is_retryable: bool, status_code: int) -> ApiCallError:
    return ApiCallError(
        f"api {status_code}",
        is_retryable=is_retryable,
        status_code=status_code,
        response_headers={},
        url="https://example/api",
    )


def test_retryable_provider_retries_natively_without_prompt_fallback() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_script.extend(
            [
                _api_error(is_retryable=True, status_code=503),
                _api_error(is_retryable=True, status_code=503),
                _ok_object('{"ok": true}'),
            ]
        )
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": True}
        assert r.model == CONFIG.model
        assert len(transport.object_calls) == 3
        # There is no equivalent of an SDK built-in retry; retry is centralized in the llm layer (with_provider_retry).
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_non_retryable_structured_400_falls_back_to_prompt_json() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_repeat = _api_error(is_retryable=False, status_code=400)
        transport.text_script.append(_ok_text('{"ok": 1}'))
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": 1}
        assert len(transport.object_calls) == 1  # no retry
        assert len(transport.text_calls) == 1

    asyncio.run(run())


def test_retryable_provider_exhausted_fails_without_fallback() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_repeat = _api_error(is_retryable=True, status_code=503)
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "PROVIDER"
        assert len(transport.object_calls) == 3  # 1 + 2 retries
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_aborted_propagates_natively_without_retry_or_fallback() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_repeat = AbortError("abort")
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "ABORTED"
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_cancellation_propagates_without_prompt_fallback() -> None:
    # Task cancellation / client disconnect (asyncio.CancelledError) is not disguised as PROVIDER but propagates
    # immediately and does not proceed to the prompt fallback (text channel) (prevents generation continuing and wasting tokens after disconnect).
    async def run() -> None:
        transport = FakeTransport()
        transport.object_repeat = asyncio.CancelledError()
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(asyncio.CancelledError):
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert len(transport.object_calls) == 1  # no retry
        assert len(transport.text_calls) == 0  # does not proceed to the fallback

    asyncio.run(run())


def test_generate_text_cancellation_is_not_wrapped() -> None:
    # On the generate_text path too, CancelledError is not wrapped into LlmError(PROVIDER) but propagates immediately.
    async def run() -> None:
        transport = FakeTransport()
        transport.text_repeat = asyncio.CancelledError()
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(asyncio.CancelledError):
            await llm.generate_text(GenerateTextRequest(prompt="p"))
        assert len(transport.text_calls) == 1

    asyncio.run(run())


def test_generate_text_retries_retryable_provider() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.text_script.extend(
            [_api_error(is_retryable=True, status_code=429), _ok_text("hi")]
        )
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_text(GenerateTextRequest(prompt="p"))
        assert r.text == "hi"
        assert len(transport.text_calls) == 2

    asyncio.run(run())


def test_output_budget_factor_expands_max_tokens() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_script.append(_ok_object('{"ok": true}'))
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        await llm.generate_object(
            GenerateObjectRequest(
                schema=JsonSchema({"type": "object"}), prompt="p", output_budget_factor=3
            )
        )
        assert transport.object_calls[0].max_tokens == CONFIG.max_output_tokens * 3

    asyncio.run(run())


def test_explicit_max_tokens_is_not_multiplied() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_script.append(_ok_object('{"ok": true}'))
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        await llm.generate_object(
            GenerateObjectRequest(
                schema=JsonSchema({"type": "object"}),
                prompt="p",
                output_budget_factor=3,
                max_output_tokens=2000,
            )
        )
        assert transport.object_calls[0].max_tokens == 2000

    asyncio.run(run())


def test_invalid_factor_is_treated_as_one() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_script.extend([_ok_object('{"ok": true}'), _ok_object('{"ok": true}')])
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        await llm.generate_object(
            GenerateObjectRequest(
                schema=JsonSchema({"type": "object"}), prompt="p", output_budget_factor=0
            )
        )
        await llm.generate_object(
            GenerateObjectRequest(
                schema=JsonSchema({"type": "object"}),
                prompt="p",
                output_budget_factor=float("nan"),
            )
        )
        assert transport.object_calls[0].max_tokens == CONFIG.max_output_tokens
        assert transport.object_calls[1].max_tokens == CONFIG.max_output_tokens

    asyncio.run(run())


def test_retry_deadline_also_scales_with_factor() -> None:
    async def run() -> None:
        # A setting where the first backoff (70s) crosses the standard deadline (60s). Without a factor, "waiting
        # would exceed the deadline" so the retry is abandoned (fails in 1 attempt); with factor 3 the deadline
        # becomes 180s so it retries (2 attempts).
        cfg = resolve_llm_env(
            {
                "KOHAKU_LLM_PROVIDER": "ollama",
                "KOHAKU_LLM_RETRY_MAX": "1",
                "KOHAKU_LLM_RETRY_INITIAL_MS": "70000",
            }
        )

        transport1 = FakeTransport()
        transport1.object_repeat = _api_error(is_retryable=True, status_code=503)
        llm1 = create_openai_compat_llm(cfg, transport=transport1, deps=DEPS)
        with pytest.raises(LlmError) as exc1:
            await llm1.generate_object(_JSON_SCHEMA_REQ)
        assert exc1.value.code == "PROVIDER"
        assert len(transport1.object_calls) == 1

        transport2 = FakeTransport()
        transport2.object_repeat = _api_error(is_retryable=True, status_code=503)
        llm2 = create_openai_compat_llm(cfg, transport=transport2, deps=DEPS)
        with pytest.raises(LlmError) as exc2:
            await llm2.generate_object(
                GenerateObjectRequest(
                    schema=JsonSchema({"type": "object"}), prompt="p", output_budget_factor=3
                )
            )
        assert exc2.value.code == "PROVIDER"
        assert len(transport2.object_calls) == 2

    asyncio.run(run())


def test_prompt_fallback_inherits_expanded_max_tokens() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.object_repeat = _api_error(is_retryable=False, status_code=400)
        transport.text_script.append(_ok_text('{"ok": 1}'))
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        await llm.generate_object(
            GenerateObjectRequest(
                schema=JsonSchema({"type": "object"}), prompt="p", output_budget_factor=3
            )
        )
        assert transport.text_calls[0].max_tokens == CONFIG.max_output_tokens * 3

    asyncio.run(run())


# --- output budget on the generate_text path (the path used by L2's raw HTML generation) --------------------


def test_generate_text_output_budget_factor_expands_max_tokens() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.text_script.append(_ok_text("hi"))
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="p", output_budget_factor=3))
        assert transport.text_calls[0].max_tokens == CONFIG.max_output_tokens * 3

    asyncio.run(run())


def test_generate_text_explicit_max_tokens_is_not_multiplied() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.text_script.append(_ok_text("hi"))
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        await llm.generate_text(
            GenerateTextRequest(prompt="p", output_budget_factor=3, max_output_tokens=2000)
        )
        assert transport.text_calls[0].max_tokens == 2000

    asyncio.run(run())


def test_generate_text_invalid_factor_is_treated_as_one() -> None:
    async def run() -> None:
        transport = FakeTransport()
        transport.text_script.extend([_ok_text("a"), _ok_text("b")])
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="p", output_budget_factor=0))
        await llm.generate_text(GenerateTextRequest(prompt="p", output_budget_factor=float("nan")))
        assert transport.text_calls[0].max_tokens == CONFIG.max_output_tokens
        assert transport.text_calls[1].max_tokens == CONFIG.max_output_tokens

    asyncio.run(run())


def test_generate_text_retry_deadline_also_scales_with_factor() -> None:
    async def run() -> None:
        # Symmetric with the same-named test on the object path: with the first backoff (70s) crossing the standard
        # deadline (60s), without a factor "waiting would exceed the deadline" abandons the retry (1 attempt), and
        # factor 3 keeps the deadline at 180s so it retries (2 attempts).
        cfg = resolve_llm_env(
            {
                "KOHAKU_LLM_PROVIDER": "ollama",
                "KOHAKU_LLM_RETRY_MAX": "1",
                "KOHAKU_LLM_RETRY_INITIAL_MS": "70000",
            }
        )

        transport1 = FakeTransport()
        transport1.text_repeat = _api_error(is_retryable=True, status_code=503)
        llm1 = create_openai_compat_llm(cfg, transport=transport1, deps=DEPS)
        with pytest.raises(LlmError) as exc1:
            await llm1.generate_text(GenerateTextRequest(prompt="p"))
        assert exc1.value.code == "PROVIDER"
        assert len(transport1.text_calls) == 1

        transport2 = FakeTransport()
        transport2.text_repeat = _api_error(is_retryable=True, status_code=503)
        llm2 = create_openai_compat_llm(cfg, transport=transport2, deps=DEPS)
        with pytest.raises(LlmError) as exc2:
            await llm2.generate_text(
                GenerateTextRequest(prompt="p", output_budget_factor=3)
            )
        assert exc2.value.code == "PROVIDER"
        assert len(transport2.text_calls) == 2

    asyncio.run(run())


def test_strict_mode_does_not_fall_back() -> None:
    async def run() -> None:
        cfg = resolve_llm_env(
            {"KOHAKU_LLM_PROVIDER": "ollama", "KOHAKU_LLM_STRUCTURED_MODE": "strict"}
        )
        transport = FakeTransport()
        transport.object_repeat = _api_error(is_retryable=False, status_code=400)
        llm = create_openai_compat_llm(cfg, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "PROVIDER"
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_prompt_mode_skips_native_channel() -> None:
    async def run() -> None:
        cfg = resolve_llm_env(
            {"KOHAKU_LLM_PROVIDER": "ollama", "KOHAKU_LLM_STRUCTURED_MODE": "prompt"}
        )
        transport = FakeTransport()
        transport.text_script.append(_ok_text('here is the answer ```json\n{"ok": 2}\n``` that is all.'))
        llm = create_openai_compat_llm(cfg, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": 2}
        assert len(transport.object_calls) == 0
        assert len(transport.text_calls) == 1

    asyncio.run(run())


def test_create_llm_builds_claude_and_gemini_adapters() -> None:
    # claude / gemini are handled by native adapters (the SDKs are installed in the dev environment).
    # The default path can build the SDK-backed transport without a CONFIG error.
    claude = create_llm(resolve_llm_env({"KOHAKU_LLM_API_KEY": "k"}))  # default provider = claude
    assert claude.provider == "claude"
    gemini = create_llm(
        resolve_llm_env({"KOHAKU_LLM_PROVIDER": "gemini", "KOHAKU_LLM_API_KEY": "k"})
    )
    assert gemini.provider == "gemini"


def test_missing_httpx_raises_runtime_error(monkeypatch: pytest.MonkeyPatch) -> None:
    # When httpx is not installed, a RuntimeError points the way (the default path with no transport injected).
    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "httpx":
            raise ImportError("No module named 'httpx'")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(RuntimeError, match=r"kohaku\[llm\]"):
        create_llm(resolve_llm_env({"KOHAKU_LLM_PROVIDER": "ollama"}))


# --- partial JSON healing (provisional partial reconstruction during streaming) ------------------------


def test_parse_partial_json_complete_input_is_returned_verbatim() -> None:
    assert _parse_partial_json('{"a": 1, "b": [2, 3]}') == {"a": 1, "b": [2, 3]}


def test_parse_partial_json_closes_unclosed_brackets() -> None:
    # Unclosed objects/arrays are reconstructed by appending closing brackets.
    assert _parse_partial_json('{"a": 1, "b": [2, 3') == {"a": 1, "b": [2, 3]}


def test_parse_partial_json_drops_trailing_comma() -> None:
    assert _parse_partial_json('{"items": [{"k": "v"},') == {"items": [{"k": "v"}]}


def test_parse_partial_json_preserves_completed_leading_content() -> None:
    # Healing only "adds closing brackets to make valid JSON" (removing incomplete elements is the consumer's =
    # build_provisional_spec's responsibility). The completed leading element is kept, and the trailing element in
    # progress is closed minimally.
    partial = _parse_partial_json(
        '{"components": [{"id": "root", "type": "layout.stack"}, {"id": "h"'
    )
    assert isinstance(partial, dict)
    assert isinstance(partial["components"], list)
    # The completed component (root) is kept verbatim.
    assert partial["components"][0] == {"id": "root", "type": "layout.stack"}


def test_parse_partial_json_mid_value_string_drops_the_incomplete_element() -> None:
    # A trailing element cut off mid value-string would break even if closed, so it is folded into an empty object
    # to make it valid (the leading completed component is kept). Deciding real components is the consumer's job.
    partial = _parse_partial_json(
        '{"components": [{"id": "root", "type": "layout.stack"}, {"id": "he'
    )
    assert isinstance(partial, dict)
    assert partial["components"][0] == {"id": "root", "type": "layout.stack"}


def test_parse_partial_json_mid_string_falls_back_to_outer_object() -> None:
    # A step cut off mid-string drops the key/value that would break even if closed, falling to the outer minimal valid form.
    assert _parse_partial_json('{"name": "hal') == {}


def test_parse_partial_json_returns_none_for_unrecoverable() -> None:
    assert _parse_partial_json("") is None
    assert _parse_partial_json("   ") is None
    assert _parse_partial_json("garbage") is None


def test_close_open_structures_rejects_overclosed_and_dangling_colon() -> None:
    assert _close_open_structures('{"a": 1}}') is None  # over-closed
    assert _close_open_structures('{"a":') is None  # a dangling colon with no value


# --- stream_object contract (SSE streaming) ----------------------------------------


class FakeStreamTransport:
    """A stub streaming transport that streams the scripted delta sequence in order and appends a usage chunk at the end."""

    def __init__(self, deltas: list[str], usage: LlmUsage | None = None) -> None:
        self.deltas = deltas
        self.usage = usage if usage is not None else LlmUsage(input_tokens=3, output_tokens=4)
        self.calls: list[ChatRequest] = []

    async def stream(
        self, req: ChatRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[ChatStreamChunk]:
        self.calls.append(req)
        for delta in self.deltas:
            yield ChatStreamChunk(delta=delta)
        yield ChatStreamChunk(usage=self.usage)


def test_stream_object_accumulates_partials_and_validates_final() -> None:
    async def run() -> None:
        seen: list[object] = []
        transport = FakeTransport()
        stream_transport = FakeStreamTransport(
            ['{"components": [', '{"id": "a"}', "]}"]
        )
        llm = create_openai_compat_llm(
            CONFIG, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        # The cumulative partial is healed from the accumulated text and notified at least twice.
        assert len(seen) >= 2
        assert seen[-1] == {"components": [{"id": "a"}]}
        # The final result is the full text validated through the normal path; usage comes from the trailing chunk.
        assert result.object == {"components": [{"id": "a"}]}
        assert result.usage == stream_transport.usage
        # Only the native structured stream is hit; it does not fall to the prompt (text) channel.
        assert len(stream_transport.calls) == 1
        assert len(transport.text_calls) == 0
        assert len(transport.object_calls) == 0

    asyncio.run(run())


def test_stream_object_swallows_on_partial_exceptions() -> None:
    async def run() -> None:
        def _boom(_partial: object) -> None:
            raise RuntimeError("consumer exception")

        transport = FakeTransport()
        stream_transport = FakeStreamTransport(['{"ok": ', "true}"])
        llm = create_openai_compat_llm(
            CONFIG, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, _boom)
        # A throw from on_partial is swallowed, and the final result returns normally (port contract).
        assert result.object == {"ok": True}

    asyncio.run(run())


def test_stream_object_without_stream_transport_falls_back_to_generate_object() -> None:
    async def run() -> None:
        seen: list[object] = []
        transport = FakeTransport()
        transport.object_script.append(_ok_object('{"ok": 9}'))
        # stream_transport not injected → streaming disabled. stream_object falls to generate_object.
        llm = create_openai_compat_llm(CONFIG, transport=transport, deps=DEPS)
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert result.object == {"ok": 9}
        assert seen == []  # no partials (fail-open)
        assert len(transport.object_calls) == 1

    asyncio.run(run())


def test_stream_object_prompt_mode_does_not_stream() -> None:
    async def run() -> None:
        cfg = resolve_llm_env(
            {"KOHAKU_LLM_PROVIDER": "ollama", "KOHAKU_LLM_STRUCTURED_MODE": "prompt"}
        )
        seen: list[object] = []
        transport = FakeTransport()
        transport.text_script.append(_ok_text('{"ok": 5}'))
        stream_transport = FakeStreamTransport(['{"ok": 5}'])
        llm = create_openai_compat_llm(
            cfg, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        # Prompt JSON mode does not stream (no partials; uses the text channel).
        assert result.object == {"ok": 5}
        assert seen == []
        assert len(stream_transport.calls) == 0
        assert len(transport.text_calls) == 1

    asyncio.run(run())


def test_stream_object_falls_back_to_prompt_on_invalid_structured_output() -> None:
    async def run() -> None:
        # When the native structured stream ends in invalid JSON (INVALID_OUTPUT), auto falls back to prompt JSON
        # exactly once (same decision as generate_object).
        seen: list[object] = []
        transport = FakeTransport()
        transport.text_script.append(_ok_text('{"ok": 7}'))
        stream_transport = FakeStreamTransport(["not json at all"])
        llm = create_openai_compat_llm(
            CONFIG, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert result.object == {"ok": 7}
        assert len(stream_transport.calls) == 1
        assert len(transport.text_calls) == 1  # prompt fallback

    asyncio.run(run())
