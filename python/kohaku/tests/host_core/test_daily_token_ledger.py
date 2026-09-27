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


def test_bounds_memory_with_max_entries_evicting_the_least_recently_touched_entry_first() -> None:
    ledger = create_daily_token_ledger(now=lambda: _DAY1_START, max_entries=2)
    ledger.record("a", 1)
    ledger.record("b", 2)  # at capacity
    ledger.record("a", 10)  # touch a again -- LRU order becomes [b, a]
    ledger.record("c", 3)  # c is new: evicts the LRU entry (b), not a

    assert ledger.spent("a") == 11  # untouched by eviction: 1 + 10
    assert ledger.spent("b") == 0  # evicted -- recording again would start a fresh entry
    assert ledger.spent("c") == 3


def test_prunes_entries_from_a_previous_utc_day_on_rollover() -> None:
    """So they never compete with today's keys for max_entries -- mirrors the TS test of the same
    intent."""
    clock = _DAY1_START
    ledger = create_daily_token_ledger(now=lambda: clock, max_entries=2)
    ledger.record("day1-a", 100)
    ledger.record("day1-b", 200)  # at capacity, both from day 1

    clock = _DAY2_START
    ledger.record("day2-x", 5)  # first day-2 call: day 1's entries are pruned before this is added
    ledger.record("day2-y", 7)  # a second brand-new key for day 2 -- must not evict day2-x

    assert ledger.spent("day2-x") == 5  # survived: day 1's entries did not occupy its slot
    assert ledger.spent("day2-y") == 7
    assert ledger.spent("day1-a") == 0
    assert ledger.spent("day1-b") == 0
