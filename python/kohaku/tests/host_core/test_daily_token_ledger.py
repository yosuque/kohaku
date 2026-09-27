"""Tests for kohaku.host_core.daily_token_ledger (port of
packages/host-core/test/daily-token-ledger.test.ts)."""

from __future__ import annotations

from datetime import UTC, datetime

from kohaku.host_core import create_daily_token_ledger

_DAY1_START = datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC).timestamp() * 1000
_DAY1_LATE = datetime(2026, 1, 1, 23, 59, 59, tzinfo=UTC).timestamp() * 1000
_DAY2_START = datetime(2026, 1, 2, 0, 0, 0, tzinfo=UTC).timestamp() * 1000


def test_starts_at_zero_for_a_key_that_has_never_recorded() -> None:
    ledger = create_daily_token_ledger(now=lambda: _DAY1_START)
    assert ledger.spent("tenant-a") == 0


def test_accumulates_within_the_same_utc_day() -> None:
    clock = _DAY1_START
    ledger = create_daily_token_ledger(now=lambda: clock)
    ledger.record("tenant-a", 100)
    clock = _DAY1_LATE
    ledger.record("tenant-a", 50)
    assert ledger.spent("tenant-a") == 150


def test_resets_automatically_across_a_utc_day_boundary() -> None:
    clock = _DAY1_LATE
    ledger = create_daily_token_ledger(now=lambda: clock)
    ledger.record("tenant-a", 500)
    assert ledger.spent("tenant-a") == 500

    clock = _DAY2_START
    assert ledger.spent("tenant-a") == 0  # reads as reset before any new record
    ledger.record("tenant-a", 10)
    assert ledger.spent("tenant-a") == 10  # did not carry yesterday's 500 forward


def test_keys_are_independent() -> None:
    ledger = create_daily_token_ledger(now=lambda: _DAY1_START)
    ledger.record("tenant-a", 100)
    ledger.record("tenant-b", 5)
    assert ledger.spent("tenant-a") == 100
    assert ledger.spent("tenant-b") == 5


def test_defaults_to_wall_clock_when_no_clock_is_injected() -> None:
    ledger = create_daily_token_ledger()
    ledger.record("tenant-a", 42)
    assert ledger.spent("tenant-a") == 42


def test_day_boundary_is_utc_not_local_time() -> None:
    # 2026-01-01T23:00:00Z and 2026-01-02T01:00:00Z: 2 hours apart, but different UTC calendar days.
    clock = datetime(2026, 1, 1, 23, 0, 0, tzinfo=UTC).timestamp() * 1000
    ledger = create_daily_token_ledger(now=lambda: clock)
    ledger.record("tenant-a", 100)
    clock = datetime(2026, 1, 2, 1, 0, 0, tzinfo=UTC).timestamp() * 1000
    assert ledger.spent("tenant-a") == 0
