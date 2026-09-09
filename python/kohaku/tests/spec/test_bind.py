"""Tests for two-way binding (resolve_bound_ref / enumerate_bind_variants)."""

from __future__ import annotations

from typing import Any

from kohaku.spec import DataRef, enumerate_bind_variants, resolve_bound_ref


def _ref(data: dict[str, Any]) -> DataRef:
    return DataRef.model_validate(data)


class TestResolveBoundRef:
    def test_no_bind_returns_ref_as_is(self) -> None:
        ref = _ref({"$ref": "query://s/p?b=2&a=1"})  # returns as-is even when non-canonical (key order)
        assert resolve_bound_ref(ref, {}) == "query://s/p?b=2&a=1"

    def test_initial_variant_returns_ref_byte_identical(self) -> None:
        """If all parameters are at their initial values, effective ref === $ref (byte-identical)."""
        ref = _ref(
            {
                "$ref": "query://s/p?region=us&fy=2026",
                "bind": {"region": {"$state": "region", "values": ["us", "eu"]}},
            }
        )
        assert resolve_bound_ref(ref, {"region": "us"}) == "query://s/p?region=us&fy=2026"

    def test_missing_state_keeps_initial(self) -> None:
        ref = _ref(
            {
                "$ref": "query://s/p?region=us",
                "bind": {"region": {"$state": "region", "values": ["us", "eu"]}},
            }
        )
        assert resolve_bound_ref(ref, {}) == "query://s/p?region=us"

    def test_changed_state_produces_canonical_ref(self) -> None:
        ref = _ref(
            {
                "$ref": "query://s/p?region=us&fy=2026",
                "bind": {"region": {"$state": "region", "values": ["us", "eu"]}},
            }
        )
        # on substitution, it is canonicalized (key-sorted)
        assert resolve_bound_ref(ref, {"region": "eu"}) == "query://s/p?fy=2026&region=eu"

    def test_non_string_state_uses_js_string(self) -> None:
        ref = _ref(
            {
                "$ref": "query://s/p?limit=10",
                "bind": {"limit": {"$state": "limit", "values": ["10", "20"]}},
            }
        )
        assert resolve_bound_ref(ref, {"limit": 20}) == "query://s/p?limit=20"


class TestEnumerateBindVariants:
    def test_no_bind_returns_canonical_single(self) -> None:
        ref = _ref({"$ref": "query://s/p?b=2&a=1"})
        assert enumerate_bind_variants(ref) == ["query://s/p?a=1&b=2"]

    def test_cartesian_product(self) -> None:
        ref = _ref(
            {
                "$ref": "query://s/p?region=us&year=2026",
                "bind": {
                    "region": {"$state": "r", "values": ["us", "eu"]},
                    "year": {"$state": "y", "values": ["2025", "2026"]},
                },
            }
        )
        variants = enumerate_bind_variants(ref)
        assert len(variants) == 4
        assert "query://s/p?region=us&year=2026" in variants  # includes the initial variant
        assert "query://s/p?region=eu&year=2025" in variants

    def test_duplicate_values_are_unified(self) -> None:
        ref = _ref(
            {
                "$ref": "query://s/p?region=us",
                "bind": {"region": {"$state": "r", "values": ["us", "us", "eu"]}},
            }
        )
        assert enumerate_bind_variants(ref) == [
            "query://s/p?region=us",
            "query://s/p?region=eu",
        ]
