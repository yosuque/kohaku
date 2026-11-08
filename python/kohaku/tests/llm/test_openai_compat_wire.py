"""Wire contract of the OpenAI-compatible adapter's default (httpx-backed) transports.

Every other adapter test injects a `ChatTransport`, which bypasses the real HTTP code entirely. Here the factory's
default path runs unmodified and only httpx's transport is swapped for an in-memory `httpx.MockTransport`, so the
URL, the auth header and the request body the adapter really builds are asserted without touching the network.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import pytest

from kohaku.llm import GenerateObjectRequest, GenerateTextRequest, JsonSchema
from kohaku.llm.abort import AbortSignal
from kohaku.llm.adapters.openai_compat import create_openai_compat_llm
from kohaku.llm.env import resolve_llm_env
from kohaku.llm.port import LlmUsage
from kohaku.llm.retry import RetryDeps

httpx = pytest.importorskip("httpx")


async def _noop_sleep(ms: float, signal: AbortSignal) -> None:
    return None


DEPS = RetryDeps(sleep=_noop_sleep, now=lambda: 0.0, random=lambda: 0.5)

CHAT_RESPONSE = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 0,
    "model": "m",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": '{"ok": true}'},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
}

STREAM_BODY = (
    'data: {"choices": [{"delta": {"content": "{\\"ok\\": "}}]}\n\n'
    'data: {"choices": [{"delta": {"content": "true}"}}]}\n\n'
    'data: {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 7}}\n\n'
    "data: [DONE]\n\n"
)


def _install_mock(monkeypatch: pytest.MonkeyPatch, respond: Callable[[Any], Any]) -> list[Any]:
    """Make the default transports build a REAL `httpx.AsyncClient` over an in-memory `MockTransport`.

    Returns the list collecting every request the adapter actually put on the wire.
    """
    requests: list[Any] = []

    def handler(request: Any) -> Any:
        requests.append(request)
        return respond(request)

    real_cls = httpx.AsyncClient

    def build(**kwargs: Any) -> Any:
        return real_cls(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", build)
    return requests


def _config(env: dict[str, str]) -> Any:
    return resolve_llm_env(env)


def test_ollama_posts_to_base_url_chat_completions_with_bearer_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests = _install_mock(monkeypatch, lambda _req: httpx.Response(200, json=CHAT_RESPONSE))
    config = _config(
        {
            "KOHAKU_LLM_PROVIDER": "ollama",
            "KOHAKU_LLM_MODEL": "gemma4:e4b",
            "KOHAKU_LLM_API_KEY": "k",
            "KOHAKU_LLM_BASE_URL": "https://gw.example/v1",
        }
    )

    async def run() -> None:
        llm = create_openai_compat_llm(config, deps=DEPS)
        result = await llm.generate_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p", system="s")
        )
        assert result.object == {"ok": True}
        assert result.usage == LlmUsage(input_tokens=5, output_tokens=7)

    asyncio.run(run())

    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://gw.example/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer k"
    assert "x-api-key" not in request.headers
    body = json.loads(request.content)
    assert body["model"] == "gemma4:e4b"
    assert body["messages"] == [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "p"},
    ]
    assert body["response_format"]["type"] == "json_schema"


def test_openai_defaults_to_the_public_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = _install_mock(monkeypatch, lambda _req: httpx.Response(200, json=CHAT_RESPONSE))
    config = _config({"KOHAKU_LLM_PROVIDER": "openai", "KOHAKU_LLM_API_KEY": "k"})

    async def run() -> None:
        llm = create_openai_compat_llm(config, deps=DEPS)
        result = await llm.generate_text(GenerateTextRequest(prompt="p"))
        assert result.text == '{"ok": true}'

    asyncio.run(run())

    assert len(requests) == 1
    assert str(requests[0].url) == "https://api.openai.com/v1/chat/completions"
    assert requests[0].headers["authorization"] == "Bearer k"
    # No response_format on a plain text call.
    assert "response_format" not in json.loads(requests[0].content)


def test_missing_api_key_falls_back_to_the_not_required_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests = _install_mock(monkeypatch, lambda _req: httpx.Response(200, json=CHAT_RESPONSE))
    config = _config(
        {
            "KOHAKU_LLM_PROVIDER": "llama",
            "KOHAKU_LLM_MODEL": "m",
            "KOHAKU_LLM_BASE_URL": "http://llama.example:8080/v1",
        }
    )

    async def run() -> None:
        llm = create_openai_compat_llm(config, deps=DEPS)
        await llm.generate_text(GenerateTextRequest(prompt="p"))

    asyncio.run(run())

    assert str(requests[0].url) == "http://llama.example:8080/v1/chat/completions"
    assert requests[0].headers["authorization"] == "Bearer not-required"


def test_stream_transport_uses_the_same_url_and_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = _install_mock(
        monkeypatch,
        lambda _req: httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=STREAM_BODY.encode()
        ),
    )
    config = _config(
        {
            "KOHAKU_LLM_PROVIDER": "ollama",
            "KOHAKU_LLM_MODEL": "m",
            "KOHAKU_LLM_API_KEY": "k",
            "KOHAKU_LLM_BASE_URL": "https://gw.example/v1",
        }
    )

    async def run() -> None:
        # stream_object is an optional capability of LlmPort (see port.supports_streaming); this adapter has it.
        llm: Any = create_openai_compat_llm(config, deps=DEPS)
        seen: list[object] = []
        result = await llm.stream_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p"),
            lambda p: seen.append(p),
        )
        assert result.object == {"ok": True}
        assert result.usage == LlmUsage(input_tokens=5, output_tokens=7)

    asyncio.run(run())

    assert len(requests) == 1
    assert str(requests[0].url) == "https://gw.example/v1/chat/completions"
    assert requests[0].headers["authorization"] == "Bearer k"
    assert json.loads(requests[0].content)["stream"] is True
