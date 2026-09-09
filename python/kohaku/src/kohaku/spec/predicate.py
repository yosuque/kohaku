"""Pure functions that evaluate a visibleWhen predicate against state (port of TS predicate.ts).

Leaf comparisons are done by equality of canonical JSON strings — matched deterministically down to key
order and array/object structure (in takes this equality element by element).

When state has no initial value for the referenced key (equivalent to undefined), it never matches the
comparison value (including null). This distinguishes "unspecified undefined" from "value is null". Note
that unknown keys in a visibleWhen leaf ref are forbidden in advance by STATE_REF_UNKNOWN, so at actual
render time a key is never unspecified.
"""

from __future__ import annotations

from .canonical_json import UNDEFINED, _Undefined, canonical_stringify
from .models import (
    AllPredicate,
    AnyPredicate,
    JsonValue,
    LeafPredicate,
    NotPredicate,
    VisibleWhen,
)


def evaluate_visible_when(pred: VisibleWhen, state: dict[str, JsonValue]) -> bool:
    if isinstance(pred, AllPredicate):
        return all(evaluate_visible_when(p, state) for p in pred.all)
    if isinstance(pred, AnyPredicate):
        return any(evaluate_visible_when(p, state) for p in pred.any)
    if isinstance(pred, NotPredicate):
        return not evaluate_visible_when(pred.not_, state)
    return _evaluate_leaf(pred, state)


def _evaluate_leaf(pred: LeafPredicate, state: dict[str, JsonValue]) -> bool:
    key = pred.ref[len("$state.") :]
    current: JsonValue | _Undefined = state.get(key, UNDEFINED)
    if pred._is_set("eq"):
        return _same_json(current, pred.eq)
    if pred._is_set("ne"):
        return not _same_json(current, pred.ne)
    if pred._is_set("in_"):
        assert pred.in_ is not None
        return any(_same_json(current, v) for v in pred.in_)
    # Numeric comparison: always false when the state value is not a number (undefined / null / string, etc.).
    if pred._is_set("gt"):
        assert pred.gt is not None
        return _is_number(current) and current > pred.gt  # type: ignore[operator]
    if pred._is_set("lt"):
        assert pred.lt is not None
        return _is_number(current) and current < pred.lt  # type: ignore[operator]
    if pred._is_set("gte"):
        assert pred.gte is not None
        return _is_number(current) and current >= pred.gte  # type: ignore[operator]
    if pred._is_set("lte"):
        assert pred.lte is not None
        return _is_number(current) and current <= pred.lte  # type: ignore[operator]
    # Existence check: match "whether the state value is other than null/undefined" against the truth of exists.
    if pred._is_set("exists"):
        present = not isinstance(current, _Undefined) and current is not None
        return present == pred.exists
    # Unreachable due to exactly-one validation, but for exhaustiveness default to visible.
    return True


def collect_state_refs(pred: VisibleWhen) -> list[str]:
    """Enumerate the state keys referenced by the predicate tree in traversal order (including duplicates)."""
    if isinstance(pred, AllPredicate):
        return [key for p in pred.all for key in collect_state_refs(p)]
    if isinstance(pred, AnyPredicate):
        return [key for p in pred.any for key in collect_state_refs(p)]
    if isinstance(pred, NotPredicate):
        return collect_state_refs(pred.not_)
    return [pred.ref[len("$state.") :]]


def _same_json(a: JsonValue | _Undefined, b: JsonValue) -> bool:
    # When a is undefined (no initial value in state), it never matches b (always a defined JSON value).
    if isinstance(a, _Undefined):
        return False
    return canonical_stringify(a) == canonical_stringify(b)


def _is_number(v: object) -> bool:
    """Equivalent to JS typeof v === "number" (bool is not a number)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)
