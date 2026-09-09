"""Public factory for LlmPort (port of TS create.ts).

TS branches per provider to an AI SDK model. The Python version branches OpenAI-compatible
(openai / ollama / llama) to `openai_compat`, claude to `anthropic_native`, and gemini to
`gemini_native`. The native adapters' SDKs (anthropic / google-genai) are optional extras,
lazily imported (a CONFIG error if not installed).
"""

from __future__ import annotations

from collections.abc import Mapping

from .env import LlmConfig, resolve_llm_env
from .port import LlmError, LlmPort

_OPENAI_COMPAT_PROVIDERS = ("openai", "ollama", "llama")


def create_llm(config: LlmConfig) -> LlmPort:
    if config.provider in _OPENAI_COMPAT_PROVIDERS:
        from .adapters.openai_compat import create_openai_compat_llm

        return create_openai_compat_llm(config)
    if config.provider == "claude":
        from .adapters.anthropic_native import create_anthropic_native_llm

        return create_anthropic_native_llm(config)
    if config.provider == "gemini":
        from .adapters.gemini_native import create_gemini_native_llm

        return create_gemini_native_llm(config)
    raise LlmError("CONFIG", f'provider "{config.provider}" is not supported')


def create_llm_from_env(env: Mapping[str, str] | None = None) -> LlmPort:
    """Build an LlmPort from environment variables (KOHAKU_LLM_*)."""
    return create_llm(resolve_llm_env(env))
