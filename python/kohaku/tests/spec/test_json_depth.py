"""Diagnostic + regression coverage for the deep-nesting recursion-DoS fix (mirrors TS's
packages/spec-core/test/json-depth.test.ts). host_rest/bodies.py's `_json_depth_ok` already runs before any
recursive parsing for the request-body fields it guards (params/payload), so this focuses on the other path
the TS fix also had to close: `JsonValue`-typed pydantic model fields (ComponentNode.props, UISpec.model_validate
as a whole, ...), validated directly via pydantic-core with no depth cap at the model layer today.

Built with a loop, never a recursive Python helper, so the fixture itself can reach depths (5000 / 100000)
that would overflow the *test's own* stack if built recursively.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from kohaku.spec.models import MAX_PREDICATE_DEPTH, ComponentNode


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


@pytest.mark.parametrize("depth", [33, 5000, 100_000])
def test_component_props_deep_nesting_does_not_crash_uncatchably(depth: int) -> None:
    """`ComponentNode.props` (`dict[str, JsonValue]`) has no depth cap at the pydantic-model layer (unlike
    TS's JsonValueSchema after the fix). Diagnostic + regression pin for pydantic-core's actual behavior on a
    deeply nested value passed straight through model_validate: whatever it does (accept, or reject with a
    ValidationError), it must never surface as an uncaught RecursionError / interpreter-level crash, since
    that would be a 500 (or a downed worker process) instead of a 400 at the host layer.
    """
    try:
        node = ComponentNode.model_validate({"id": "root", "type": "x", "props": {"a": nested_object(depth)}})
    except ValidationError:
        return  # Rejected -- fine either way (see docstring); nothing further to check.
    # Accepted: confirm it round-trips back out (to_wire) without incident either, since that is the next
    # recursive traversal a composed/persisted Spec goes through.
    assert node.props["a"] is not None


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
