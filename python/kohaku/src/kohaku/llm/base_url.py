"""Normalisation of `KOHAKU_LLM_BASE_URL` to the provider's vendor root (port of TS `base-url.ts`).

claude / gemini take the vendor root *without* the API-version path (`https://gw.example`, not
`https://gw.example/v1`); a trailing `/v1` (claude) or `/v1beta` (gemini) is stripped so both spellings name the
same endpoint in both language ports. The Python SDKs append the version themselves, so the root is passed to
them as-is (the TypeScript provider SDKs want the versioned base, so the TS adapter re-appends it).
openai / ollama / llama follow the OpenAI-compatible convention (the value includes `/v1`) and are returned
trimmed but otherwise unchanged. Pinned across languages by the `llmBaseUrl` cross-language golden.
"""

from __future__ import annotations

import re

from .env import LlmProvider

_VERSION_SEGMENT: dict[str, str] = {"claude": "/v1", "gemini": "/v1beta"}
_TRAILING_SLASHES = re.compile(r"/+$")


def normalize_vendor_base_url(provider: LlmProvider, base_url: str | None) -> str | None:
    """Return the vendor root for `base_url`, or None when it is unset/blank (use the SDK default endpoint)."""
    trimmed = base_url.strip() if base_url is not None else ""
    if trimmed == "":
        return None
    segment = _VERSION_SEGMENT.get(provider)
    if segment is None:
        return trimmed
    root = _TRAILING_SLASHES.sub("", trimmed)
    if root.endswith(segment):
        root = _TRAILING_SLASHES.sub("", root[: -len(segment)])
    return root or None
