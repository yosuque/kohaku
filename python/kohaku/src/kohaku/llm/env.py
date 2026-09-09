"""Configuration resolution from environment variables (KOHAKU_LLM_*) (port of TS env.ts).

Defaults and validation match TS. See also the environment-variable table in docs/specification.md.
Field names change from TS's camelCase to snake_case (this is the product-internal Python API).
"""

from __future__ import annotations

import math
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, cast

from .port import LlmError

type LlmProvider = Literal["claude", "openai", "gemini", "ollama", "llama"]

type StructuredMode = Literal["auto", "strict", "prompt"]


@dataclass(frozen=True)
class RetryPolicy:
    """Exponential backoff with jitter for transient PROVIDER-side failures (rate limits, temporary outages)."""

    max_retries: int
    """Maximum number of retries (excluding the first attempt). 0 disables retries."""
    initial_delay_ms: int
    """Initial backoff wait (milliseconds)."""
    backoff_factor: float
    """Backoff multiplier (base is multiplied per attempt)."""
    jitter: float
    """Jitter ratio (0..1). Perturbs base by ±jitter."""


@dataclass(frozen=True)
class LlmConfig:
    provider: LlmProvider
    model: str
    api_key: str | None
    base_url: str | None
    temperature: float
    max_output_tokens: int
    structured_mode: StructuredMode
    """auto: native structured output → fall back to prompt JSON on failure (default).
    strict: native only / prompt: always prompt JSON (+ caller-side schema validation)."""
    timeout_ms: int
    """Timeout for a single LLM call (milliseconds). Aborted when exceeded. Default 60000."""
    retry: RetryPolicy
    """Retry policy for PROVIDER failures. The whole sequence never exceeds timeout_ms."""
    prompt_cache: bool = False
    """Opt-in Anthropic prompt caching (`cache_control`). Default False
    (KOHAKU_LLM_PROMPT_CACHE unset or anything other than "1"). When True and the caller supplies
    GenerateObjectRequest/GenerateTextRequest's `prompt_parts`, the anthropic_native adapter splits the
    `claude` provider's user message into two content blocks and marks the leading (`cacheable`) one with
    `cache_control: {"type": "ephemeral"}`. A no-op for every other provider and a no-op whenever the caller
    passes no `prompt_parts` — mirrors TS's `LlmConfig.promptCache` exactly (see packages/llm/src/env.ts)."""


# Retry defaults (conservative). The backoff factor and jitter are not exposed via env; they are fixed constants.
_DEFAULT_RETRY_MAX = 2
_DEFAULT_RETRY_INITIAL_MS = 250
_RETRY_BACKOFF_FACTOR = 2.0
_RETRY_JITTER = 0.25

_PROVIDERS: tuple[LlmProvider, ...] = ("claude", "openai", "gemini", "ollama", "llama")

# claude: bumped from "claude-sonnet-4-6" to "claude-sonnet-5" (2026-09; mirrors TS's env.ts, confirmed
# present in the installed anthropic SDK's model literals). Since the model id is part of
# default_generator_version (prompt.py), this changes the *default* cacheKey for any operator who never
# sets KOHAKU_LLM_MODEL: previously cached L0/L1/L2 entries for the default model miss exactly once after
# upgrading, then repopulate under the new model id. openai / gemini / ollama / llama are left untouched
# (not verified against primary sources as part of this change, matching the TS side's scope).
_DEFAULT_MODELS: dict[LlmProvider, str | None] = {
    "claude": "claude-sonnet-5",
    "openai": "gpt-4.1",
    "gemini": "gemini-2.5-flash",
    "ollama": "llama3.3",
    "llama": None,  # Required: the model name of the OpenAI-compatible endpoint must be specified.
}

# Provider-standard API key environment variables (KOHAKU_LLM_API_KEY takes precedence).
_STANDARD_KEY_ENV: dict[LlmProvider, str] = {
    "claude": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GOOGLE_GENERATIVE_AI_API_KEY",
}


def _js_number(raw: str) -> float:
    """Numeric conversion mirroring JS's `Number(x)`. Whitespace-only / empty is 0, failure is NaN."""
    s = raw.strip()
    if s == "":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return float("nan")


def _require_int(raw: str, name: str, *, allow_zero: bool, suffix: str = "") -> int:
    n = _js_number(raw)
    ok = math.isfinite(n) and n.is_integer() and (n >= 0 if allow_zero else n > 0)
    if not ok:
        kind = "non-negative integer" if allow_zero else "positive integer"
        raise LlmError("CONFIG", f"{name} must be a {kind}{suffix}")
    return int(n)


def resolve_llm_env(env: Mapping[str, str] | None = None) -> LlmConfig:
    e = os.environ if env is None else env

    provider_raw = e.get("KOHAKU_LLM_PROVIDER", "claude")
    if provider_raw not in _PROVIDERS:
        raise LlmError(
            "CONFIG",
            f'KOHAKU_LLM_PROVIDER must be one of {", ".join(_PROVIDERS)} (got "{provider_raw}")',
        )
    provider = provider_raw

    model = e.get("KOHAKU_LLM_MODEL") or _DEFAULT_MODELS[provider]
    if not model:
        raise LlmError("CONFIG", f'KOHAKU_LLM_MODEL is required for provider "{provider}"')

    key = e.get("KOHAKU_LLM_API_KEY")
    standard = _STANDARD_KEY_ENV.get(provider)
    if key is None:
        key = e.get(standard) if standard is not None else None
    api_key = key
    # Warn at startup if a key-required provider (claude/openai/gemini = those defined in _STANDARD_KEY_ENV)
    # has no key set (onboarding aid; not a hard fail: the L0 deterministic path is designed to work without a
    # key). Under stdio MCP, stdout is the JSON-RPC channel, so the warning goes to stderr (equivalent to TS env.ts's console.warn).
    if standard is not None and not api_key:
        print(
            f'[kohaku] No API key configured for LLM provider "{provider}" '
            f"(set KOHAKU_LLM_API_KEY or {standard}). "
            "The L0 deterministic path works, but L1/L2 generation requires a key.",
            file=sys.stderr,
        )

    base_url = e.get("KOHAKU_LLM_BASE_URL")
    if provider == "ollama" and not base_url:
        base_url = "http://localhost:11434/v1"
    if provider == "llama" and not base_url:
        raise LlmError(
            "CONFIG",
            'provider "llama" requires KOHAKU_LLM_BASE_URL (an OpenAI-compatible endpoint)',
        )

    temperature = _js_number(e.get("KOHAKU_LLM_TEMPERATURE", "0"))
    if not math.isfinite(temperature) or temperature < 0:
        raise LlmError("CONFIG", "KOHAKU_LLM_TEMPERATURE must be a non-negative number")

    max_output_tokens = _require_int(
        e.get("KOHAKU_LLM_MAX_OUTPUT_TOKENS", "4096"), "KOHAKU_LLM_MAX_OUTPUT_TOKENS", allow_zero=False
    )

    structured_mode_raw = e.get("KOHAKU_LLM_STRUCTURED_MODE", "auto")
    if structured_mode_raw not in ("auto", "strict", "prompt"):
        raise LlmError("CONFIG", "KOHAKU_LLM_STRUCTURED_MODE must be auto | strict | prompt")
    structured_mode = cast("StructuredMode", structured_mode_raw)

    timeout_ms = _require_int(
        e.get("KOHAKU_LLM_TIMEOUT_MS", "60000"), "KOHAKU_LLM_TIMEOUT_MS", allow_zero=False, suffix=" (milliseconds)"
    )

    max_retries = _require_int(
        e.get("KOHAKU_LLM_RETRY_MAX", str(_DEFAULT_RETRY_MAX)),
        "KOHAKU_LLM_RETRY_MAX",
        allow_zero=True,
        suffix=" (0 disables retries)",
    )
    retry_initial_ms = _require_int(
        e.get("KOHAKU_LLM_RETRY_INITIAL_MS", str(_DEFAULT_RETRY_INITIAL_MS)),
        "KOHAKU_LLM_RETRY_INITIAL_MS",
        allow_zero=False,
        suffix=" (milliseconds)",
    )

    # Opt-in, default off. Only "1" enables it (any other value, including unset, is off) — matches the
    # documented env contract exactly (same convention as TS's env.ts).
    prompt_cache = e.get("KOHAKU_LLM_PROMPT_CACHE") == "1"

    return LlmConfig(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        structured_mode=structured_mode,
        timeout_ms=timeout_ms,
        retry=RetryPolicy(
            max_retries=max_retries,
            initial_delay_ms=retry_initial_ms,
            backoff_factor=_RETRY_BACKOFF_FACTOR,
            jitter=_RETRY_JITTER,
        ),
        prompt_cache=prompt_cache,
    )
