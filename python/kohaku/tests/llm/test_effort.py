"""Tests for reasoning-effort wiring (GenerateObjectRequest/GenerateTextRequest.effort).

A pytest port of packages/llm/test/ai-sdk-effort.test.ts's scenarios. Injects each adapter's transport to
verify the wire-level request it builds, without calling a real LLM.
"""

from __future__ import annotations

import asyncio

from kohaku.llm import GenerateObjectRequest, GenerateTextRequest, JsonSchema
from kohaku.llm.abort import AbortSignal
from kohaku.llm.adapters.anthropic_native import (
    AnthropicRequest,
    AnthropicResponse,
    create_anthropic_native_llm,
)
from kohaku.llm.adapters.gemini_native import (
    GeminiRequest,
    GeminiResponse,
    create_gemini_native_llm,
)
from kohaku.llm.adapters.openai_compat import ChatRequest, ChatResponse, create_openai_compat_llm
from kohaku.llm.env import resolve_llm_env
from kohaku.llm.port import LlmUsage
from kohaku.llm.retry import RetryDeps

_JSON_SCHEMA_REQ = GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")


async def _noop_sleep(ms: float, signal: AbortSignal) -> None:
    return None


DEPS = RetryDeps(sleep=_noop_sleep, now=lambda: 0.0, random=lambda: 0.5)


class _AnthropicTransport:
    def __init__(self) -> None:
        self.calls: list[AnthropicRequest] = []

    async def __call__(
        self, req: AnthropicRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AnthropicResponse:
        self.calls.append(req)
        return AnthropicResponse(
            tool_input={"ok": True} if req.tool is not None else None,
            text="ok",
            usage=LlmUsage(input_tokens=1, output_tokens=1),
        )


class _ChatTransport:
    def __init__(self) -> None:
        self.calls: list[ChatRequest] = []

    async def __call__(self, req: ChatRequest, *, timeout_ms: float, signal: AbortSignal) -> ChatResponse:
        self.calls.append(req)
        text = '{"ok": true}' if req.response_format is not None else "ok"
        return ChatResponse(text=text, usage=LlmUsage(input_tokens=1, output_tokens=1))


class _GeminiTransport:
    def __init__(self) -> None:
        self.calls: list[GeminiRequest] = []

    async def __call__(
        self, req: GeminiRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> GeminiResponse:
        self.calls.append(req)
        text = '{"ok": true}' if req.response_schema is not None else "ok"
        return GeminiResponse(text=text, usage=LlmUsage(input_tokens=1, output_tokens=1))


def test_effort_unset_sends_no_effort_field() -> None:
    async def run() -> None:
        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k"})
        transport = _AnthropicTransport()
        llm = create_anthropic_native_llm(config, transport=transport, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="hi"))
        assert transport.calls[0].effort is None

    asyncio.run(run())


def test_claude_effort_reaches_anthropic_request_and_output_config() -> None:
    async def run() -> None:
        from kohaku.llm.adapters.anthropic_native import _output_config_params

        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k"})
        transport = _AnthropicTransport()
        llm = create_anthropic_native_llm(config, transport=transport, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="hi", effort="high"))
        req = transport.calls[0]
        assert req.effort == "high"
        # Wire-level shape: output_config={"effort": "high"} (the installed anthropic SDK's OutputConfigParam).
        assert _output_config_params(req) == {"output_config": {"effort": "high"}}

    asyncio.run(run())


def test_claude_generate_object_also_carries_effort() -> None:
    async def run() -> None:
        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k"})
        transport = _AnthropicTransport()
        llm = create_anthropic_native_llm(config, transport=transport, deps=DEPS)
        req = GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p", effort="low")
        await llm.generate_object(req)
        assert transport.calls[0].effort == "low"

    asyncio.run(run())


def test_openai_effort_sent_as_reasoning_effort() -> None:
    async def run() -> None:
        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "openai", "KOHAKU_LLM_API_KEY": "k"})
        transport = _ChatTransport()
        llm = create_openai_compat_llm(config, transport=transport, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="hi", effort="low"))
        assert transport.calls[0].reasoning_effort == "low"

    asyncio.run(run())


def test_ollama_effort_sent_as_reasoning_effort() -> None:
    async def run() -> None:
        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "ollama"})
        transport = _ChatTransport()
        llm = create_openai_compat_llm(config, transport=transport, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="hi", effort="medium"))
        assert transport.calls[0].reasoning_effort == "medium"

    asyncio.run(run())


def test_llama_effort_sent_as_reasoning_effort() -> None:
    async def run() -> None:
        config = resolve_llm_env(
            {
                "KOHAKU_LLM_PROVIDER": "llama",
                "KOHAKU_LLM_BASE_URL": "http://localhost:9999/v1",
                "KOHAKU_LLM_MODEL": "my-local-model",
            }
        )
        transport = _ChatTransport()
        llm = create_openai_compat_llm(config, transport=transport, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="hi", effort="xhigh"))
        assert transport.calls[0].reasoning_effort == "xhigh"

    asyncio.run(run())


def test_gemini_effort_is_silently_ignored() -> None:
    async def run() -> None:
        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "gemini", "KOHAKU_LLM_API_KEY": "k"})
        transport = _GeminiTransport()
        llm = create_gemini_native_llm(config, transport=transport, deps=DEPS)
        # GeminiRequest has no effort field at all — the call must simply not raise, and the request
        # carries no trace of "effort" (there is nothing to assert beyond "it was accepted and ignored").
        await llm.generate_text(GenerateTextRequest(prompt="hi", effort="max"))
        assert transport.calls[0].response_schema is None

    asyncio.run(run())


def test_openai_compat_structured_output_also_carries_effort() -> None:
    async def run() -> None:
        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "openai", "KOHAKU_LLM_API_KEY": "k"})
        transport = _ChatTransport()
        llm = create_openai_compat_llm(config, transport=transport, deps=DEPS)
        req = GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p", effort="high")
        await llm.generate_object(req)
        assert transport.calls[0].reasoning_effort == "high"

    asyncio.run(run())
