"""Tests for _compose_deadline_ms (KOHAKU_COMPOSE_DEADLINE_MS parsing).

Mirrors the TS sample's composeDeadlineMs contract (apps/sample-api/src/app/compose-context.ts): unset /
non-numeric / <= 0 all fall back to the default, and a valid positive integer is honored verbatim.
"""

from __future__ import annotations

from sales_api.app import _compose_deadline_ms


def test_defaults_to_240000ms_when_unset() -> None:
    assert _compose_deadline_ms({}) == 240_000


def test_honors_a_valid_positive_integer() -> None:
    assert _compose_deadline_ms({"KOHAKU_COMPOSE_DEADLINE_MS": "5000"}) == 5000


def test_falls_back_to_default_for_non_numeric_input() -> None:
    assert _compose_deadline_ms({"KOHAKU_COMPOSE_DEADLINE_MS": "not-a-number"}) == 240_000


def test_falls_back_to_default_for_zero_or_negative_input() -> None:
    assert _compose_deadline_ms({"KOHAKU_COMPOSE_DEADLINE_MS": "0"}) == 240_000
    assert _compose_deadline_ms({"KOHAKU_COMPOSE_DEADLINE_MS": "-100"}) == 240_000
