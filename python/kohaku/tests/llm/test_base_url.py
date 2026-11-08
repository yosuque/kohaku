"""Edge cases of `normalize_vendor_base_url` (mirror of packages/llm/test/base-url.test.ts)."""

from __future__ import annotations

from kohaku.llm.base_url import normalize_vendor_base_url


def test_unset_empty_and_blank_are_ignored_for_every_provider() -> None:
    for provider in ("claude", "openai", "gemini", "ollama", "llama"):
        assert normalize_vendor_base_url(provider, None) is None
        assert normalize_vendor_base_url(provider, "") is None
        assert normalize_vendor_base_url(provider, "  ") is None


def test_claude_strips_slashes_and_one_trailing_v1_segment() -> None:
    assert normalize_vendor_base_url("claude", "https://gw.example/v1/") == "https://gw.example"
    assert (
        normalize_vendor_base_url("claude", "https://gw.example/anthropic/v1")
        == "https://gw.example/anthropic"
    )
    # Only a trailing, whole segment counts: /v10 is a path of its own.
    assert normalize_vendor_base_url("claude", "https://gw.example/v10") == "https://gw.example/v10"


def test_gemini_strips_slashes_and_one_trailing_v1beta_segment() -> None:
    assert normalize_vendor_base_url("gemini", "https://gw.example/v1beta/") == "https://gw.example"


def test_openai_compatible_providers_keep_the_value_as_given() -> None:
    for provider in ("openai", "ollama", "llama"):
        assert (
            normalize_vendor_base_url(provider, "https://gw.example/v1/")
            == "https://gw.example/v1/"
        )
