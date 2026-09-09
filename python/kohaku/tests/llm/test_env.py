"""Tests for configuration resolution from environment variables (the resolveLlmEnv scenarios of llm.test.ts as pytest)."""

from __future__ import annotations

import pytest

from kohaku.llm import LlmError, resolve_llm_env


def test_defaults_to_claude_and_default_model() -> None:
    config = resolve_llm_env({})
    assert config.provider == "claude"
    assert config.model == "claude-sonnet-5"
    assert config.temperature == 0
    assert config.max_output_tokens == 4096


def test_kohaku_key_takes_precedence_over_standard_key() -> None:
    config = resolve_llm_env(
        {"KOHAKU_LLM_API_KEY": "kohaku-key", "ANTHROPIC_API_KEY": "anthropic-key"}
    )
    assert config.api_key == "kohaku-key"


def test_falls_back_to_standard_provider_key() -> None:
    config = resolve_llm_env({"ANTHROPIC_API_KEY": "anthropic-key"})
    assert config.api_key == "anthropic-key"


def test_ollama_has_default_base_url() -> None:
    config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "ollama"})
    assert config.base_url == "http://localhost:11434/v1"
    assert config.model == "llama3.3"


def test_llama_requires_base_url_and_model() -> None:
    with pytest.raises(LlmError, match="KOHAKU_LLM"):
        resolve_llm_env({"KOHAKU_LLM_PROVIDER": "llama"})
    config = resolve_llm_env(
        {
            "KOHAKU_LLM_PROVIDER": "llama",
            "KOHAKU_LLM_BASE_URL": "http://localhost:8080/v1",
            "KOHAKU_LLM_MODEL": "qwen3-32b",
        }
    )
    assert config.model == "qwen3-32b"


def test_invalid_provider_is_config_error() -> None:
    with pytest.raises(LlmError, match="must be one of") as exc:
        resolve_llm_env({"KOHAKU_LLM_PROVIDER": "gpt"})
    assert exc.value.code == "CONFIG"


def test_timeout_ms_default_and_positive_integer_only() -> None:
    assert resolve_llm_env({}).timeout_ms == 60000
    assert resolve_llm_env({"KOHAKU_LLM_TIMEOUT_MS": "30000"}).timeout_ms == 30000
    with pytest.raises(LlmError, match="TIMEOUT_MS"):
        resolve_llm_env({"KOHAKU_LLM_TIMEOUT_MS": "0"})
    with pytest.raises(LlmError, match="TIMEOUT_MS"):
        resolve_llm_env({"KOHAKU_LLM_TIMEOUT_MS": "abc"})


def test_retry_defaults_and_validation() -> None:
    config = resolve_llm_env({})
    assert config.retry.max_retries == 2
    assert config.retry.initial_delay_ms == 250
    # RETRY_MAX allows 0 (disabled) but not a negative value. RETRY_INITIAL_MS is a positive integer only.
    assert resolve_llm_env({"KOHAKU_LLM_RETRY_MAX": "0"}).retry.max_retries == 0
    with pytest.raises(LlmError, match="RETRY_MAX"):
        resolve_llm_env({"KOHAKU_LLM_RETRY_MAX": "-1"})
    with pytest.raises(LlmError, match="RETRY_INITIAL_MS"):
        resolve_llm_env({"KOHAKU_LLM_RETRY_INITIAL_MS": "0"})


def test_structured_mode_validation() -> None:
    assert resolve_llm_env({}).structured_mode == "auto"
    assert resolve_llm_env({"KOHAKU_LLM_STRUCTURED_MODE": "prompt"}).structured_mode == "prompt"
    with pytest.raises(LlmError, match="STRUCTURED_MODE"):
        resolve_llm_env({"KOHAKU_LLM_STRUCTURED_MODE": "grammar"})


def test_temperature_must_be_non_negative() -> None:
    assert resolve_llm_env({"KOHAKU_LLM_TEMPERATURE": "0.7"}).temperature == pytest.approx(0.7)
    with pytest.raises(LlmError, match="TEMPERATURE"):
        resolve_llm_env({"KOHAKU_LLM_TEMPERATURE": "-1"})


class TestMissingKeyWarning:
    """D6: for a key-required provider with no key set, warn to stderr at startup (equivalent to TS env.ts's console.warn).

    It is not a hard fail (the L0 deterministic path works without a key). Wire / exception behavior is unchanged.
    """

    def test_warns_and_does_not_pollute_stdout(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        config = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "openai"})
        captured = capsys.readouterr()
        assert "No API key configured" in captured.err
        assert "OPENAI_API_KEY" in captured.err
        # Does not pollute the stdio MCP's JSON-RPC channel (stdout).
        assert captured.out == ""
        # The warning still succeeds at resolving the config (no hard fail).
        assert config.api_key is None

    def test_no_warning_when_key_present(self, capsys: pytest.CaptureFixture[str]) -> None:
        resolve_llm_env({"KOHAKU_LLM_API_KEY": "k"})
        assert "No API key configured" not in capsys.readouterr().err
        resolve_llm_env({"ANTHROPIC_API_KEY": "k"})  # no warning for the standard key either
        assert "No API key configured" not in capsys.readouterr().err

    def test_no_warning_for_keyless_providers(self, capsys: pytest.CaptureFixture[str]) -> None:
        # ollama / llama require no key (not in _STANDARD_KEY_ENV), so no warning.
        resolve_llm_env({"KOHAKU_LLM_PROVIDER": "ollama"})
        assert capsys.readouterr().err == ""
