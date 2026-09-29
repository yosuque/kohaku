"""Diagnostic + regression coverage for the deep-nesting recursion-DoS fix (mirrors TS's
packages/spec-core/test/json-depth.test.ts). host_rest/bodies.py's `json_depth_ok` (now shared from kohaku.spec) already runs before any
recursive parsing for the request-body fields it guards (params/payload), so this focuses on the other path
the TS fix also had to close: `JsonValue`-typed pydantic model fields, validated directly via pydantic-core --
ComponentNode.props now enforces the same 32-level cap as TS's ComponentNodeSchema (accept 32, reject 33).

Built with a loop, never a recursive Python helper, so the fixture itself can reach depths (5000 / 100000)
that would overflow the *test's own* stack if built recursively.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from kohaku.spec.models import MAX_JSON_OBJECT_DEPTH, MAX_PREDICATE_DEPTH, ComponentNode


def nested_object(depth: int) -> dict[str, object]:
    """A dict literal nested `depth` levels deep (a bare `{"leaf": True}` is depth 1)."""
    obj: dict[str, object] = {"leaf": True}
    for _ in range(1, depth):
        obj = {"nested": obj}
    return obj


def nested_not(depth: int) -> dict[str, object]:
    """A `visibleWhen` predicate nested `depth` `not`s deep (a bare leaf is depth 1). Mirrors TS's
    packages/spec-core/test/state.test.ts's own nest() helper."""
    obj: dict[str, object] = {"ref": "$state.tab", "eq": "a"}
    for _ in range(1, depth):
        obj = {"not": obj}
    return obj


def test_component_props_value_at_the_depth_limit_is_accepted() -> None:
    """Mirrors TS's ComponentNodeSchema: each `props` value is a JsonValue whose own nesting (the value
    itself = depth 1) may reach MAX_JSON_OBJECT_DEPTH levels."""
    node = ComponentNode.model_validate(
        {"id": "root", "type": "x", "props": {"a": nested_object(MAX_JSON_OBJECT_DEPTH)}}
    )
    assert node.props["a"] is not None


@pytest.mark.parametrize("depth", [MAX_JSON_OBJECT_DEPTH + 1, 5000, 100_000])
def test_component_props_value_beyond_the_depth_limit_is_rejected(depth: int) -> None:
    """One level past the limit -- and the pathological depths that would otherwise reach pydantic-core's
    own recursion -- is a ValidationError, never accepted and never an uncaught RecursionError."""
    with pytest.raises(ValidationError, match="nested too deeply"):
        ComponentNode.model_validate({"id": "root", "type": "x", "props": {"a": nested_object(depth)}})


def test_component_props_depth_cap_applies_to_every_value_and_to_arrays() -> None:
    deep_list: object = ["leaf"]
    for _ in range(1, MAX_JSON_OBJECT_DEPTH + 1):
        deep_list = [deep_list]
    with pytest.raises(ValidationError, match="nested too deeply"):
        ComponentNode.model_validate(
            {"id": "root", "type": "x", "props": {"ok": 1, "deep": deep_list}}
        )


@pytest.mark.parametrize("depth", [MAX_PREDICATE_DEPTH, MAX_PREDICATE_DEPTH + 1, 33, 5000, 100_000])
def test_visible_when_deep_nesting_does_not_crash_uncatchably(depth: int) -> None:
    """Companion to the JSON-depth fix's TS follow-up (packages/spec-core/src/schema/state.ts's
    VisibleWhenSchema): `visibleWhen`'s `AllPredicate`/`AnyPredicate`/`NotPredicate` recursive union is
    validated by pydantic *before* the `@field_validator("visibleWhen", mode="after")` depth check runs --
    the same ordering as TS's pre-fix superRefine. Diagnostic + regression pin: whatever pydantic-core does
    with a pathologically deep predicate (accept at/under MAX_PREDICATE_DEPTH, or reject at any depth beyond
    it), it must never surface as an uncaught RecursionError.
    """
    try:
        node = ComponentNode.model_validate(
            {"id": "root", "type": "x", "visibleWhen": nested_not(depth)}
        )
    except ValidationError as e:
        if depth <= MAX_PREDICATE_DEPTH:
            pytest.fail(f"depth {depth} (<= the limit) should have been accepted: {e}")
        return
    assert depth <= MAX_PREDICATE_DEPTH, f"depth {depth} (> the limit) should have been rejected"
    assert node.visibleWhen is not None
