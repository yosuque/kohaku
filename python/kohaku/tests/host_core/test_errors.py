"""Tests for format_error_chain / create_console_error_reporter (port of
packages/host-core/test/errors.test.ts's additions for the same two building blocks).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest

from kohaku.composer import ComposeErrorContext
from kohaku.host_core import (
    LLM_PROVIDER_UNAVAILABLE_MESSAGE,
    ConsoleErrorReporterOptions,
    HostErrorClass,
    classify_host_error,
    create_console_error_reporter,
    fail_open,
    format_error_chain,
    is_llm_unavailable_error,
    is_typed_host_error,
)
from kohaku.llm import LlmError
from kohaku.spec import Intent, SpecError


class TestFormatErrorChain:
    def test_formats_a_single_exception_with_no_cause_as_one_segment(self) -> None:
        assert format_error_chain(RuntimeError("boom")) == "RuntimeError: boom"

    def test_walks_the_cause_chain_joining_from_immediate_failure_to_root_cause(self) -> None:
        root = TypeError("network down")
        try:
            try:
                raise root
            except TypeError as e:
                raise RuntimeError("provider call failed") from e
        except RuntimeError as middle:
            try:
                raise RuntimeError("compose failed") from middle
            except RuntimeError as top:
                assert format_error_chain(top) == (
                    "RuntimeError: compose failed <- RuntimeError: provider call failed <- "
                    "TypeError: network down"
                )

    def test_stringifies_a_non_exception_value_passed_directly(self) -> None:
        # Python's __cause__ is type-enforced (None or BaseException) unlike TS's Error.cause, so a
        # non-exception value can only ever appear as the top-level `err` here, never mid-chain -- e.g. when
        # a ComposeObserver.onError caller passes a plain reason string instead of an actual exception.
        assert format_error_chain("just a string") == "just a string"

    def test_stops_at_max_depth_rather_than_looping_forever_on_a_circular_cause_chain(self) -> None:
        a = RuntimeError("a")
        b = RuntimeError("b")
        b.__cause__ = a
        a.__cause__ = b  # a <- b <- a <- b <- ... (circular)
        result = format_error_chain(a, max_depth=4)
        assert len(result.split(" <- ")) == 4


@dataclass(frozen=True)
class _HostErrorInfo:
    """A minimal stand-in for kohaku.host_rest.deps.HostErrorInfo, structurally compatible with
    create_console_error_reporter's `host` handler (host_core cannot import host_rest)."""

    endpoint: str
    request_id: str
    error: object


class TestCreateConsoleErrorReporter:
    def test_debug_false_logs_a_one_line_summary_for_the_host_hook(self) -> None:
        lines: list[str] = []
        reporter = create_console_error_reporter(ConsoleErrorReporterOptions(log=lines.append))
        reporter.host(_HostErrorInfo(endpoint="/compose", request_id="r1", error=RuntimeError("boom")))
        assert lines == ["[kohaku] /compose (request r1): boom"]

    def test_debug_true_logs_the_full_cause_chain_and_the_traceback_as_separate_lines(self) -> None:
        lines: list[str] = []
        reporter = create_console_error_reporter(ConsoleErrorReporterOptions(debug=True, log=lines.append))
        try:
            try:
                raise RuntimeError("root cause")
            except RuntimeError as cause:
                raise RuntimeError("top failure") from cause
        except RuntimeError as err:
            reporter.host(_HostErrorInfo(endpoint="/compose", request_id="r1", error=err))

        assert len(lines) == 1
        line = lines[0]
        assert "[kohaku] /compose (request r1): RuntimeError: top failure <- RuntimeError: root cause" in line
        assert "Traceback" in line

    def test_compose_a_fallback_with_no_raised_error_logs_ctx_reason_instead(self) -> None:
        lines: list[str] = []
        reporter = create_console_error_reporter(ConsoleErrorReporterOptions(log=lines.append))
        ctx = ComposeErrorContext(
            phase="fallback",
            input="intent",
            reason="L1 constrained generation failed catalog/structure validation",
        )
        reporter.compose(ctx, None)
        assert lines == [
            "[kohaku] compose fallback: L1 constrained generation failed catalog/structure validation"
        ]

    def test_compose_tier_and_intent_are_in_the_prefix_when_the_context_carries_them(self) -> None:
        lines: list[str] = []
        reporter = create_console_error_reporter(ConsoleErrorReporterOptions(log=lines.append))
        ctx = ComposeErrorContext(
            phase="fallback",
            input="intent",
            tier="L1",
            intent=Intent(canonical="sales.overview", params={}, hash="sha256:" + "0" * 64),
            reason="generation failed",
        )
        reporter.compose(ctx, None)
        assert lines == ["[kohaku] compose fallback (tier L1, intent sales.overview): generation failed"]

    def test_compose_a_hard_failure_logs_the_raised_error(self) -> None:
        lines: list[str] = []
        reporter = create_console_error_reporter(ConsoleErrorReporterOptions(log=lines.append))
        ctx = ComposeErrorContext(phase="hard", input="intent")
        reporter.compose(ctx, RuntimeError("reference resolution failed"))
        assert lines == ["[kohaku] compose hard: reference resolution failed"]

    def test_defaults_to_printing_to_stderr_when_log_is_not_supplied(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        reporter = create_console_error_reporter()
        reporter.host(_HostErrorInfo(endpoint="/compose", request_id="r1", error=RuntimeError("boom")))
        captured = capsys.readouterr()
        assert captured.err.strip() == "[kohaku] /compose (request r1): boom"
        assert captured.out == ""


class TestFailOpen:
    def test_reports_an_exception_to_on_failure_instead_of_raising(self) -> None:
        boom = RuntimeError("record failed")
        reported: list[BaseException] = []

        async def fn() -> None:
            raise boom

        async def on_failure(e: BaseException) -> None:
            reported.append(e)

        asyncio.run(fail_open(fn, on_failure))
        assert reported == [boom]

    def test_does_not_swallow_a_cancellation(self) -> None:
        reported: list[BaseException] = []

        async def fn() -> None:
            raise asyncio.CancelledError

        async def on_failure(e: BaseException) -> None:
            reported.append(e)

        async def run() -> None:
            await fail_open(fn, on_failure)

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(run())
        assert reported == []


_RAW_SDK_MESSAGE = "[claude/x] Anthropic API key is missing. Pass it using the 'apiKey' parameter."


class _DuckLlmError(Exception):
    """A look-alike LlmError from a hypothetical duplicate install: same class name, string `code`."""

    def __init__(self, code: str) -> None:
        super().__init__(_RAW_SDK_MESSAGE)
        self.code = code


_DuckLlmError.__name__ = "LlmError"


class TestIsTypedHostErrorLlmDenyList:
    @pytest.mark.parametrize("code", ["CONFIG", "INVALID_OUTPUT", "PROVIDER", "ABORTED"])
    def test_an_llm_error_is_never_typed(self, code: str) -> None:
        assert not is_typed_host_error(LlmError(code, _RAW_SDK_MESSAGE))  # type: ignore[arg-type]

    def test_a_duck_typed_llm_error_is_never_typed(self) -> None:
        assert not is_typed_host_error(_DuckLlmError("CONFIG"))

    def test_the_general_string_code_rule_is_unchanged_for_other_errors(self) -> None:
        coded = Exception("governance failed")
        coded.code = "PROMOTION_NOT_PUBLISHED"  # type: ignore[attr-defined]
        assert is_typed_host_error(coded)
        assert is_typed_host_error(SpecError("PARSE_FAILED", "bad spec"))
        assert not is_typed_host_error(Exception("boom"))


class TestIsLlmUnavailableError:
    @pytest.mark.parametrize("code", ["PROVIDER", "CONFIG", "ABORTED"])
    def test_is_true_for_provider_config_and_aborted(self, code: str) -> None:
        assert is_llm_unavailable_error(LlmError(code, "x"))  # type: ignore[arg-type]

    def test_is_false_for_invalid_output(self) -> None:
        assert not is_llm_unavailable_error(LlmError("INVALID_OUTPUT", "x"))

    def test_is_true_for_a_duck_typed_llm_error_and_false_for_an_unrelated_coded_error(self) -> None:
        assert is_llm_unavailable_error(_DuckLlmError("PROVIDER"))
        unrelated = Exception("x")
        unrelated.code = "PROVIDER"  # type: ignore[attr-defined]
        assert not is_llm_unavailable_error(unrelated)

    def test_is_false_for_a_non_exception_value(self) -> None:
        assert not is_llm_unavailable_error("PROVIDER")


class TestClassifyHostError:
    @pytest.mark.parametrize("code", ["PROVIDER", "CONFIG", "ABORTED"])
    def test_maps_an_unavailable_llm_error_to_the_fixed_message(self, code: str) -> None:
        cls = classify_host_error(LlmError(code, _RAW_SDK_MESSAGE))  # type: ignore[arg-type]
        assert cls == HostErrorClass("upstream_unavailable", LLM_PROVIDER_UNAVAILABLE_MESSAGE)
        assert "API key" not in (cls.message or "")

    def test_maps_invalid_output_to_untyped(self) -> None:
        assert classify_host_error(LlmError("INVALID_OUTPUT", "raw")) == HostErrorClass("untyped")

    def test_maps_typed_errors_to_their_own_message(self) -> None:
        assert classify_host_error(SpecError("PARSE_FAILED", "bad spec")) == HostErrorClass("typed", "bad spec")
        coded = Exception("governance failed")
        coded.code = "PROMOTION_NOT_PUBLISHED"  # type: ignore[attr-defined]
        assert classify_host_error(coded) == HostErrorClass("typed", "governance failed")

    def test_maps_a_plain_exception_and_a_non_exception_to_untyped(self) -> None:
        assert classify_host_error(Exception("boom")) == HostErrorClass("untyped")
        assert classify_host_error("boom") == HostErrorClass("untyped")

    def test_the_fixed_message_matches_the_typescript_text(self) -> None:
        assert (
            LLM_PROVIDER_UNAVAILABLE_MESSAGE
            == "LLM provider unavailable; see the host's observability hook (onError) for details"
        )
