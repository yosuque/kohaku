"""Unwrapping of a nullable `anyOf` property (port of nullable.ts)."""

from __future__ import annotations


def unwrap_nullable(prop: object) -> object:
    """Unwrap the "optional" encoding some MCP SDKs produce for a parameter that may be null: Pydantic (the
    Python MCP SDK) writes `Optional[int]` as `{"anyOf": [{"type": "integer"}, {"type": "null"}]}`. Returns the
    non-null branch, or the property itself when it is not of that exact two-branch shape.

    Used where a parameter's scalar type is read (string-argument coercion, Intent params). It is deliberately
    not used by the `paramsSchema` projection, which treats every `anyOf` as unrepresentable.
    """
    if not isinstance(prop, dict):
        return prop
    branches = prop.get("anyOf")
    if not isinstance(branches, list) or len(branches) != 2:
        return prop

    def is_null(branch: object) -> bool:
        return isinstance(branch, dict) and branch.get("type") == "null"

    if sum(1 for branch in branches if is_null(branch)) != 1:
        return prop
    return next(branch for branch in branches if not is_null(branch))
