"""Tests for finalize_intent (port of packages/spec-core/test/intent.test.ts's finalize_intent cases)."""

from __future__ import annotations

from kohaku.spec import IntentInput, finalize_intent


def test_finalize_intent_returns_normalized_params_and_a_hash() -> None:
    intent = finalize_intent(IntentInput(canonical="sales.records", params={"region": "japan", "limit": 100}))
    assert list(intent.params.keys()) == ["limit", "region"]
    assert intent.hash.startswith("sha256:")


def test_finalize_intent_skips_recomputation_when_already_an_intent() -> None:
    """Re-finalizing an already-finalized Intent (CanonicalIntent) returns the same object (identity-preserving
    fast path), rather than recomputing an identical hash from scratch."""
    first = finalize_intent(IntentInput(canonical="sales.records", params={"region": "japan", "limit": 100}))
    second = finalize_intent(first)
    assert second is first
