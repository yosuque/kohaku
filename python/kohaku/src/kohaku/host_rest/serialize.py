"""JSON-ification helper for response bodies.

TS (Hono) JSON-ifies any plain object as-is, but Python mixes pydantic models, dataclasses, and plain dicts. To
unify the wire shape:
- A value with `to_wire()` (a pydantic model / ComponentDraft, etc.) uses that as the source of truth.
- A dataclass recursively converts its fields and drops None fields (symmetric with TS's undefined omission).
- dict values are converted recursively (explicit null inside a payload is preserved).
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
