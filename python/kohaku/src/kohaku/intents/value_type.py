"""Derive valueType / enum values from a param field (port of TS value-type.ts).

The TS version walks zod's internal `.def` to strip wrappers (default / optional) and determine the base type,
but the Python version determines it directly from the param_schema type DSL (NumberField / EnumField /
StringField) (default / optional are folded into each field's flags, so no wrapper deconstruction is needed).
"""

from __future__ import annotations

from typing import Literal

from .param_schema import EnumField, NumberField, ParamField


def facet_value_type(field: ParamField) -> Literal["number", "string"]:
    """Derive the valueType for client coerce.

    The z.coerce.number(...) equivalent (NumberField) is "number"; everything else (enum / string, etc.) is "string".
    Since it is derived from the same source as the server-side coerce, the client coerce (whether "2026" → 2026)
    and the server validation match by definition.
    """
    return "number" if isinstance(field, NumberField) else "string"


def enum_values_of(field: ParamField) -> list[str] | None:
    """Return the value members of an enum-family field (for facet derivation when options is omitted). None if not an enum."""
    if isinstance(field, EnumField):
        return list(field.values)
    return None
