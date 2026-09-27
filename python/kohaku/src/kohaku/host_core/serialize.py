"""JSON-ification helper shared by the host profiles.

TS's JSON.stringify serializes any plain object as-is, but Python mixes pydantic models, dataclasses, and plain
dicts. To unify the wire shape:
- A value with `to_wire()` (a pydantic model / ComponentDraft, etc.) uses that as the source of truth.
- A dataclass recursively converts its fields and drops None fields (symmetric with TS's undefined omission).
- dict values are converted recursively (explicit null inside a payload is preserved).

Originally REST-only (kohaku.host_rest.serialize, still re-exported there for backward compatibility), moved
here once kohaku.host_mcp needed the identical conversion for a dataclass-valued `_meta` entry (design.md #64's
Action manifest): host_rest and host_mcp are independent sibling layers (pyproject.toml's
`[tool.importlinter]` forbids either importing the other), so a utility both need has to live upstream of both,
in host_core, rather than being duplicated or borrowed across the sibling boundary.
"""

from __future__ import annotations

import dataclasses
from typing import Any


def to_jsonable(value: Any) -> Any:
    """Recursively convert any value into a plain JSON-able structure (dict / list / scalar)."""
    if value is None or isinstance(value, bool | int | float | str):
        return value

    # pydantic models, ComponentDraft, QueryTemplate, TabularData, etc. know their own wire shape.
    to_wire = getattr(value, "to_wire", None)
    if callable(to_wire):
        return to_jsonable(to_wire())

    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out: dict[str, Any] = {}
        for f in dataclasses.fields(value):
            field_value = getattr(value, f.name)
            # Drop None fields, symmetric with TS's optional (undefined) omission.
            if field_value is None:
                continue
            out[f.name] = to_jsonable(field_value)
        return out

    if isinstance(value, dict):
        # Preserve explicit null (None) inside a payload (handled differently from dataclass fields).
        return {str(k): to_jsonable(v) for k, v in value.items()}

    if isinstance(value, list | tuple | set):
        return [to_jsonable(v) for v in value]

    # Return an unexpected type as-is (defer to the downstream JSON encoder = surface it early).
    return value


__all__ = ["to_jsonable"]
