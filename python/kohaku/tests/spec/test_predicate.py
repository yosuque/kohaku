"""Tests for visibleWhen predicate evaluation (identical semantics to TS predicate.ts)."""

from __future__ import annotations

from typing import Any

from kohaku.spec import collect_state_refs, evaluate_visible_when
from kohaku.spec.models import AllPredicate, AnyPredicate, LeafPredicate, NotPredicate


def _leaf(**kwargs: Any) -> LeafPredicate:
    return LeafPredicate.model_validate(kwargs)


class TestLeafComparisons:
    def test_eq_canonical_equality(self) -> None:
        pred = _leaf(ref="$state.obj", eq={"b": 1, "a": [1, 2]})
        # canonically equal even with different key order
        assert evaluate_visible_when(pred, {"obj": {"a": [1, 2], "b": 1}}) is True
        assert evaluate_visible_when(pred, {"obj": {"a": [2, 1], "b": 1}}) is False

    def test_eq_null_vs_missing(self) -> None:
        """Distinguish "value is null" from "key unspecified"."""
        pred = _leaf(ref="$state.k", eq=None)
        assert evaluate_visible_when(pred, {"k": None}) is True
        assert evaluate_visible_when(pred, {}) is False

    def test_ne(self) -> None:
        pred = _leaf(ref="$state.k", ne="a")
        assert evaluate_visible_when(pred, {"k": "b"}) is True
        assert evaluate_visible_when(pred, {"k": "a"}) is False
        # an unspecified key is true for ne (undefined !== "a")
        assert evaluate_visible_when(pred, {}) is True

    def test_in(self) -> None:
        pred = _leaf(ref="$state.k", **{"in": ["a", 1, None]})
        assert evaluate_visible_when(pred, {"k": "a"}) is True
        assert evaluate_visible_when(pred, {"k": 1}) is True
        assert evaluate_visible_when(pred, {"k": None}) is True
        assert evaluate_visible_when(pred, {"k": "z"}) is False
        assert evaluate_visible_when(pred, {}) is False

    def test_numeric_comparisons(self) -> None:
        assert evaluate_visible_when(_leaf(ref="$state.n", gt=5), {"n": 6}) is True
        assert evaluate_visible_when(_leaf(ref="$state.n", gt=5), {"n": 5}) is False
        assert evaluate_visible_when(_leaf(ref="$state.n", gte=5), {"n": 5}) is True
        assert evaluate_visible_when(_leaf(ref="$state.n", lt=5), {"n": 4}) is True
        assert evaluate_visible_when(_leaf(ref="$state.n", lte=5), {"n": 5}) is True

    def test_numeric_with_non_number_is_false(self) -> None:
        """Always false when the state value is not a number (string / bool / null / unspecified)."""
        non_numbers: list[Any] = ["6", True, None]
        for value in non_numbers:
            assert evaluate_visible_when(_leaf(ref="$state.n", gt=5), {"n": value}) is False
        assert evaluate_visible_when(_leaf(ref="$state.n", gt=5), {}) is False

    def test_exists(self) -> None:
        assert evaluate_visible_when(_leaf(ref="$state.k", exists=True), {"k": 0}) is True
        assert evaluate_visible_when(_leaf(ref="$state.k", exists=True), {"k": None}) is False
        assert evaluate_visible_when(_leaf(ref="$state.k", exists=True), {}) is False
        assert evaluate_visible_when(_leaf(ref="$state.k", exists=False), {}) is True
        assert evaluate_visible_when(_leaf(ref="$state.k", exists=False), {"k": None}) is True


class TestComposite:
    def test_all_any_not(self) -> None:
        state: dict[str, Any] = {"a": 1, "b": "x"}
        all_pred = AllPredicate.model_validate(
            {"all": [{"ref": "$state.a", "eq": 1}, {"ref": "$state.b", "eq": "x"}]}
        )
        assert evaluate_visible_when(all_pred, state) is True
        any_pred = AnyPredicate.model_validate(
            {"any": [{"ref": "$state.a", "eq": 99}, {"ref": "$state.b", "eq": "x"}]}
        )
        assert evaluate_visible_when(any_pred, state) is True
        not_pred = NotPredicate.model_validate({"not": {"ref": "$state.a", "eq": 1}})
        assert evaluate_visible_when(not_pred, state) is False


def test_collect_state_refs_traversal_order() -> None:
    pred = AllPredicate.model_validate(
        {
            "all": [
                {"ref": "$state.a", "eq": 1},
                {"any": [{"ref": "$state.b", "eq": 2}, {"not": {"ref": "$state.a", "eq": 3}}]},
            ]
        }
    )
    assert collect_state_refs(pred) == ["a", "b", "a"]
