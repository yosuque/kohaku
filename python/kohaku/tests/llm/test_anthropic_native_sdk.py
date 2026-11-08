"""Regression: the default (SDK-backed) anthropic transports, exercised through the real `anthropic` SDK.

Every other test in `test_anthropic_native.py` injects an `AnthropicTransport`, which bypasses
`_SdkTransport` / `_SdkStreamTransport` entirely — so a request keyword the real SDK does not accept (the SDK
has no `temperature` parameter on `messages.create`, and from anthropic-version 2026-10-21 the API rejects
sampling parameters outright) sailed through. Here the real `anthropic.AsyncAnthropic` is built by the
factory's default path and pointed at an in-memory `httpx2.MockTransport`, so nothing touches the network.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import pytest

from kohaku.llm import GenerateObjectRequest, GenerateTextRequest, JsonSchema
from kohaku.llm.abort import AbortSignal
from kohaku.llm.adapters.anthropic_native import create_anthropic_native_llm
from kohaku.llm.env import resolve_llm_env
from kohaku.llm.port import LlmUsage
from kohaku.llm.retry import RetryDeps

anthropic = pytest.importorskip("anthropic")
httpx2 = pytest.importorskip("httpx2")

CONFIG = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k"})

_SAMPLING_KEYS = ("temperature", "top_p", "top_k")


async def _noop_sleep(ms: float, signal: AbortSignal) -> None:
    return None


DEPS = RetryDeps(sleep=_noop_sleep, now=lambda: 0.0, random=lambda: 0.5)


def _message(content: list[dict[str, Any]], stop_reason: str) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": CONFIG.model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 5, "output_tokens": 7},
    }


def _sse(events: list[tuple[str, dict[str, Any]]]) -> bytes:
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode()


def _stream_body(partials: list[str]) -> bytes:
    events: list[tuple[str, dict[str, Any]]] = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": _message([], "end_turn") | {"stop_reason": None},
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "response",
                    "input": {},
                },
            },
        ),
    ]
    for partial in partials:
        events.append(
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": partial},
                },
            )
        )
    events += [
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                "usage": {"output_tokens": 7},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    return _sse(events)


def _install_mock(
    monkeypatch: pytest.MonkeyPatch, respond: Callable[[Any], Any]
) -> list[dict[str, Any]]:
    """Make the factory's default path build a REAL `AsyncAnthropic` whose HTTP layer is in-memory.

    Returns the list that collects every request body (parsed JSON) the SDK actually put on the wire.
    """
    bodies: list[dict[str, Any]] = []

    def handler(request: Any) -> Any:
        bodies.append(json.loads(request.content))
        return respond(request)

    http_client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    real_cls = anthropic.AsyncAnthropic

    def build(**kwargs: Any) -> Any:
        return real_cls(**kwargs, http_client=http_client)

    monkeypatch.setattr(anthropic, "AsyncAnthropic", build)
    return bodies


def _assert_no_sampling_params(body: dict[str, Any]) -> None:
    for key in _SAMPLING_KEYS:
        assert key not in body, f"{key} must not be sent to the Anthropic Messages API"


def test_default_transport_generate_object_sends_no_sampling_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tool_use = {"type": "tool_use", "id": "toolu_1", "name": "response", "input": {"ok": True}}
    bodies = _install_mock(
        monkeypatch,
        lambda _req: httpx2.Response(200, json=_message([tool_use], "tool_use")),
    )

    async def run() -> None:
        llm = create_anthropic_native_llm(CONFIG, deps=DEPS)
        result = await llm.generate_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")
        )
        assert result.object == {"ok": True}
        assert result.usage == LlmUsage(input_tokens=5, output_tokens=7)

    asyncio.run(run())
    assert len(bodies) == 1
    _assert_no_sampling_params(bodies[0])
    assert bodies[0]["tool_choice"] == {"type": "tool", "name": "response"}


def test_default_transport_generate_text_sends_no_sampling_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bodies = _install_mock(
        monkeypatch,
        lambda _req: httpx2.Response(
            200, json=_message([{"type": "text", "text": "hello"}], "end_turn")
        ),
    )

    async def run() -> None:
        llm = create_anthropic_native_llm(CONFIG, deps=DEPS)
        # An explicit per-call temperature is accepted by the port but must not reach the wire.
        result = await llm.generate_text(GenerateTextRequest(prompt="p", temperature=0.7))
        assert result.text == "hello"

    asyncio.run(run())
    assert len(bodies) == 1
    _assert_no_sampling_params(bodies[0])


def test_default_stream_transport_sends_no_sampling_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = _stream_body(['{"components": [', '{"id": "a"}', "]}"])
    bodies = _install_mock(
        monkeypatch,
        lambda _req: httpx2.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        ),
    )

    async def run() -> None:
        llm = create_anthropic_native_llm(CONFIG, deps=DEPS)
        seen: list[object] = []
        result = await llm.stream_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p"),
            lambda p: seen.append(p),
        )
        assert result.object == {"components": [{"id": "a"}]}
        assert result.usage == LlmUsage(input_tokens=5, output_tokens=7)
        assert seen

    asyncio.run(run())
    assert len(bodies) == 1
    assert bodies[0]["stream"] is True
    _assert_no_sampling_params(bodies[0])
