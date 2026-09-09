"""Tests for parse_trace_context / TRACEPARENT_RE (port of packages/host-core/test/trace-context.test.ts)."""

from __future__ import annotations

from kohaku.host_core import TRACEPARENT_RE, TraceContext, parse_trace_context

VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
ALL_ZERO_TRACE_ID = "00-00000000000000000000000000000000-00f067aa0ba902b7-01"
ALL_ZERO_PARENT_ID = "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"
UPPERCASE_HEX = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"
VERSION_FF = "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
TRACE_ID_TOO_SHORT = "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01"
PARENT_ID_TOO_LONG = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7ff-01"
MISSING_FLAGS_FIELD = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"


class TestTraceparentRe:
    def test_accepts_a_strictly_w3c_formatted_traceparent(self) -> None:
        assert TRACEPARENT_RE.match(VALID)

    def test_rejects_an_all_zero_trace_id(self) -> None:
        assert TRACEPARENT_RE.match(ALL_ZERO_TRACE_ID) is None

    def test_rejects_an_all_zero_parent_id(self) -> None:
        assert TRACEPARENT_RE.match(ALL_ZERO_PARENT_ID) is None

    def test_rejects_uppercase_hex(self) -> None:
        assert TRACEPARENT_RE.match(UPPERCASE_HEX) is None

    def test_rejects_a_version_byte_other_than_00(self) -> None:
        assert TRACEPARENT_RE.match(VERSION_FF) is None

    def test_rejects_a_trace_id_shorter_than_32_hex_characters(self) -> None:
        assert TRACEPARENT_RE.match(TRACE_ID_TOO_SHORT) is None

    def test_rejects_a_parent_id_longer_than_16_hex_characters(self) -> None:
        assert TRACEPARENT_RE.match(PARENT_ID_TOO_LONG) is None

    def test_rejects_a_traceparent_missing_the_flags_field(self) -> None:
        assert TRACEPARENT_RE.match(MISSING_FLAGS_FIELD) is None


class TestParseTraceContext:
    def test_returns_a_trace_context_for_a_valid_traceparent_with_no_tracestate(self) -> None:
        assert parse_trace_context(VALID) == TraceContext(traceparent=VALID)

    def test_returns_a_trace_context_with_tracestate_when_both_are_valid(self) -> None:
        assert parse_trace_context(VALID, "vendor=value") == TraceContext(
            traceparent=VALID, tracestate="vendor=value"
        )

    def test_returns_none_for_an_all_zero_trace_id(self) -> None:
        assert parse_trace_context(ALL_ZERO_TRACE_ID) is None

    def test_returns_none_for_an_all_zero_parent_id(self) -> None:
        assert parse_trace_context(ALL_ZERO_PARENT_ID) is None

    def test_returns_none_for_uppercase_hex(self) -> None:
        assert parse_trace_context(UPPERCASE_HEX) is None

    def test_returns_none_for_a_version_byte_other_than_00(self) -> None:
        assert parse_trace_context(VERSION_FF) is None

    def test_returns_none_for_wrong_segment_lengths(self) -> None:
        assert parse_trace_context(TRACE_ID_TOO_SHORT) is None
        assert parse_trace_context(PARENT_ID_TOO_LONG) is None

    def test_returns_none_for_a_missing_field(self) -> None:
        assert parse_trace_context(MISSING_FLAGS_FIELD) is None

    def test_returns_none_for_a_non_string_or_missing_traceparent(self) -> None:
        assert parse_trace_context(None) is None
        assert parse_trace_context(123) is None

    def test_drops_an_empty_string_tracestate_rather_than_carrying_it(self) -> None:
        assert parse_trace_context(VALID, "") == TraceContext(traceparent=VALID)

    def test_drops_a_non_string_tracestate(self) -> None:
        assert parse_trace_context(VALID, 42) == TraceContext(traceparent=VALID)

    def test_carries_a_tracestate_at_exactly_the_512_character_cap(self) -> None:
        tracestate = "a" * 512
        assert parse_trace_context(VALID, tracestate) == TraceContext(traceparent=VALID, tracestate=tracestate)

    def test_drops_a_tracestate_longer_than_512_characters_but_still_carries_the_traceparent(self) -> None:
        tracestate = "a" * 513
        assert parse_trace_context(VALID, tracestate) == TraceContext(traceparent=VALID)
