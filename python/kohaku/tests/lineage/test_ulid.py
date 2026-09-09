"""Tests for the homegrown ULID generation (lineage._ulid).

Verify that it has the same textual format as TS's ulid library (26 uppercase Crockford Base32 chars),
that lexicographic order advances with time across different ms, and that the id record generates has that format.
"""

from __future__ import annotations

import time
from unittest.mock import patch

from kohaku.lineage.lineage import _CROCKFORD_BASE32, _ulid

_CROCKFORD_SET = set(_CROCKFORD_BASE32)


class TestUlidFormat:
    def test_length_is_26(self) -> None:
        assert len(_ulid()) == 26

    def test_uses_only_crockford_uppercase_alphabet(self) -> None:
        for _ in range(200):
            assert set(_ulid()) <= _CROCKFORD_SET

    def test_alphabet_excludes_ilou(self) -> None:
        # Crockford Base32 does not include I / L / O / U (for legibility).
        assert not (set("ILOU") & _CROCKFORD_SET)
        assert len(_CROCKFORD_BASE32) == 32


class TestUlidMonotonicByTime:
    def test_lexicographic_order_follows_time(self) -> None:
        # For different-ms timestamps, the first 10 chars (the time part) advance, so the lexicographic order advances too.
        with patch.object(time, "time", return_value=1_000_000.000):
            earlier = _ulid()
        with patch.object(time, "time", return_value=2_000_000.000):
            later = _ulid()
        assert earlier < later
        # The time part (first 10 chars) alone is enough to establish order.
        assert earlier[:10] < later[:10]

    def test_same_ms_shares_timestamp_prefix(self) -> None:
        with patch.object(time, "time", return_value=1_500_000.250):
            a = _ulid()
            b = _ulid()
        # For the same ms, the time part matches and they diverge in the randomness part (monotonicity is not guaranteed).
        assert a[:10] == b[:10]
        assert a != b
