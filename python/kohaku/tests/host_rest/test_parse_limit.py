"""Tests for _parse_limit (mirrors TS host-rest's parse-limit.test.ts).

Representative-input table shared with the TS side: only a plain decimal-digit string (with an optional
decimal point) is accepted -- hex / scientific notation / underscore separators, all of which a bare
`float(raw)` (Python) or `Number(raw)` (TS) would otherwise accept in one language but not the other, are
rejected in both.
"""

from __future__ import annotations

import pytest

from kohaku.host_rest._routes.shared import _parse_limit

MAX_LIMIT = 1000


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", None),
        ("0", None),
        ("-1", None),
        ("abc", None),
        ("0x10", None),  # hex: not a decimal-digit string (int("0x10", 16) would accept it; float() rejects it).
        ("1_000", None),  # numeric-separator underscore: float("1_000") is 1000.0, but this is not a decimal-digit string.
        ("1e3", None),  # scientific notation: float("1e3") is 1000.0, but this is not a decimal-digit string.
        ("1.9", 1),  # a valid decimal is floored (int() truncation, equivalent to floor for positives).
        ("500", 500),
        ("5000", MAX_LIMIT),  # over the limit is clamped, not rejected.
    ],
)
def test_parse_limit_representative_inputs(raw: str, expected: int | None) -> None:
    assert _parse_limit(raw, MAX_LIMIT, None) == expected


def test_parse_limit_none_input_defers_to_default() -> None:
    assert _parse_limit(None, MAX_LIMIT, None) is None
    assert _parse_limit(None, MAX_LIMIT, 200) == 200


def test_parse_limit_invalid_input_defers_to_default() -> None:
    assert _parse_limit("abc", MAX_LIMIT, 200) == 200
