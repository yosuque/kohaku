"""Turns the string parameters of a resolved `query://` ref into typed MCP tool arguments (port of coerce.ts).

Pinned to the TS implementation by the cross-language golden fixture (`domainMcp.argumentCoercion`).
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any

from kohaku.spec import JsonObject, JsonValue

from .nullable import unwrap_nullable

# The reserved ref parameters (data_binding's KNOWN_RESERVED_PARAMS) that are never forwarded as-is.
_RESERVED = frozenset({"_cursor", "_limit", "_sort", "_dir"})

# Strict JSON-number grammar: no padding, no hex, no Infinity / NaN. ASCII digits only ([0-9], not \d: in a
# Python str pattern \d also matches other Unicode digits, which JS's \d does not).
_NUMBER_PATTERN = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?")

# 2**53: below this an integral float converts to an int exactly, as a JS number is printed.
_SAFE_INTEGER = 2**53


class McpArgumentError(ValueError):
    """A string argument cannot be converted to the type the tool's `inputSchema` asks for.

    Carries the wire code `ACTION_PARAMS_INVALID` (a host-authored validation error, safe to show the caller).
    """

    code = "ACTION_PARAMS_INVALID"


def _property_type(input_schema: Mapping[str, Any], name: str) -> str | None:
    properties = input_schema.get("properties")
    if not isinstance(properties, dict) or name not in properties:
        return None
    prop = unwrap_nullable(properties[name])
    if not isinstance(prop, dict):
        return None
    type_ = prop.get("type")
    return type_ if isinstance(type_, str) else None


def _coerce_value(name: str, value: JsonValue, type_: str | None) -> JsonValue:
    if not isinstance(value, str):
        return value
    if type_ in ("number", "integer"):
        parsed = float(value) if _NUMBER_PATTERN.fullmatch(value) else math.nan
        if not math.isfinite(parsed) or (type_ == "integer" and not parsed.is_integer()):
            expected = "an integer" if type_ == "integer" else "a number"
            raise McpArgumentError(f'argument "{name}": expected {expected}')
        # JS has one number type: 3 and 3.0 are the same value, so an integral float becomes an int.
        return int(parsed) if parsed.is_integer() and abs(parsed) < _SAFE_INTEGER else parsed
    if type_ == "boolean":
        if value == "true":
            return True
        if value == "false":
            return False
        raise McpArgumentError(f'argument "{name}": expected "true" or "false"')
    return value


def coerce_tool_arguments(
    args: Mapping[str, JsonValue], input_schema: Mapping[str, Any]
) -> JsonObject:
    """Convert ref parameters into MCP tool arguments.

    Each string is converted to the `type` the tool's `inputSchema` declares for it (`number`, `integer`,
    `boolean`; everything else stays a string), and a value that does not convert raises `McpArgumentError`. The
    reserved parameters (`_cursor`, `_limit`, `_sort`, `_dir`) are never forwarded, except that `_limit` is
    mapped onto the tool's own `limit` argument when its `inputSchema` declares one (and then wins over an
    explicit `limit`). A value that is not a string is kept as is.
    """
    out: JsonObject = {}
    for name, value in args.items():
        if name in _RESERVED:
            continue
        out[name] = _coerce_value(name, value, _property_type(input_schema, name))
    limit_type = _property_type(input_schema, "limit")
    if "_limit" in args and limit_type is not None:
        out["limit"] = _coerce_value("limit", args["_limit"], limit_type)
    return out
