"""Wire contract of the gemini adapter's default (google-genai-backed) transports.

`test_gemini_native.py` injects transports, which bypasses `_SdkTransport` entirely. Here the factory's default
path builds a REAL `google.genai.Client` and only its HTTP layer is replaced by an in-memory
`httpx.MockTransport`, so the final request URL (and the API key header) the SDK really produces are asserted
without touching the network. The URL expectations come from the cross-language golden, the same one the
TypeScript provider's wire test reads.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import pytest

from kohaku.llm import GenerateTextRequest
from kohaku.llm.abort import AbortSignal
from kohaku.llm.adapters.gemini_native import create_gemini_native_llm
from kohaku.llm.env import resolve_llm_env
from kohaku.llm.retry import RetryDeps

httpx = pytest.importorskip("httpx")
genai = pytest.importorskip("google.genai")

GEMINI_RESPONSE = {
    "candidates": [
        {
            "content": {"role": "model", "parts": [{"text": "hello"}]},
            "finishReason": "STOP",
            "index": 0,
        }
    ],
    "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 7, "totalTokenCount": 12},
}


async def _noop_sleep(ms: float, signal: AbortSignal) -> None:
    return None


DEPS = RetryDeps(sleep=_noop_sleep, now=lambda: 0.0, random=lambda: 0.5)


def _install_mock(monkeypatch: pytest.MonkeyPatch, respond: Callable[[Any], Any]) -> list[Any]:
    """Make the default path build a REAL `genai.Client` whose async HTTP client is in-memory."""
    requests: list[Any] = []

    def handler(request: Any) -> Any:
        requests.append(request)
        return respond(request)

    real_cls = genai.Client

    def build(**kwargs: Any) -> Any:
        options = kwargs.get("http_options") or genai.types.HttpOptions()
        options.httpx_async_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return real_cls(**{**kwargs, "http_options": options})

    monkeypatch.setattr(genai, "Client", build)
    return requests


def _run(config: Any) -> None:
    async def run() -> None:
        llm = create_gemini_native_llm(config, deps=DEPS)
        result = await llm.generate_text(GenerateTextRequest(prompt="p"))
        assert result.text == "hello"

    asyncio.run(run())


def test_request_url_and_key_header_match_the_cross_language_golden(
    monkeypatch: pytest.MonkeyPatch, cross_language_fixture: dict[str, Any]
) -> None:
    cases = [c for c in cross_language_fixture["llmBaseUrl"] if c["provider"] == "gemini"]
    assert any(c["baseUrl"].endswith("/v1beta") for c in cases)
    assert any(c["baseUrl"] == "https://gw.example" for c in cases)
    requests = _install_mock(monkeypatch, lambda _req: httpx.Response(200, json=GEMINI_RESPONSE))
    base = resolve_llm_env(
        {"KOHAKU_LLM_PROVIDER": "gemini", "KOHAKU_LLM_API_KEY": "k", "KOHAKU_LLM_MODEL": "m"}
    )
    for case in cases:
        requests.clear()

        _run(replace(base, base_url=case["baseUrl"]))

        assert len(requests) == 1, case
        # The SDK's own default is `…/v1beta/models/m:generateContent`; gateways get the same path.
        assert str(requests[0].url) == case["requestUrl"], case
        assert requests[0].headers["x-goog-api-key"] == "k"
