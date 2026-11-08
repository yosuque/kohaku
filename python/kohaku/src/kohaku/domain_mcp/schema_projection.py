"""Projection of an MCP tool's `inputSchema` onto kohaku's closed `paramsSchema` subset (port of
schema-projection.ts).

The output, the `dropped` list and the `reasons` list are pinned to the TS implementation by the cross-language
golden fixture (`domainMcp.schemaProjection`), so any change here has to be made on both sides.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, cast

# Keywords carried over into the subset (type-specific ones are kept only on a node of that type).
_OBJECT_KEYWORDS = ("properties", "required", "additionalProperties")
_NUMBER_KEYWORDS = ("minimum", "maximum")
_STRING_KEYWORDS = ("minLength", "maxLength")
_ARRAY_KEYWORDS = ("items", "maxItems")

# Keywords dropped without making the schema unrepresentable: annotations, plus constraints the subset lacks
# (`pattern`: regex dialects differ between the TS and Python hosts; `format`: informational). Anything outside
# this set and outside the kept set is structural (`anyOf`, `$ref`, `not`, ...) and omits the whole schema.
_DROPPED_KEYWORDS = frozenset(
    {
        "$schema",
        "$id",
        "$comment",
        "$defs",
        "definitions",
        "title",
        "description",
        "default",
        "examples",
        "example",
        "deprecated",
        "readOnly",
        "writeOnly",
        "format",
        "pattern",
        "const",
        "multipleOf",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minItems",
        "uniqueItems",
        "minProperties",
        "maxProperties",
        "contentMediaType",
        "contentEncoding",
    }
)

_SCALAR_TYPES = frozenset({"object", "array", "string", "number", "integer", "boolean"})


@dataclass
class SchemaProjection:
    """The result of projecting an `inputSchema` (TS `SchemaProjection`)."""

    schema: dict[str, Any] | None
    """The projected schema, or None when the input cannot be represented in the subset (`omitted`)."""
    dropped: list[str] = field(default_factory=list)
    """Dot-separated paths of the keywords dropped on the way (`properties.q.description`)."""
    omitted: bool = False
    """True when no schema is attached to the operation (see `reasons`)."""
    reasons: list[str] = field(default_factory=list)
    """Dot-separated paths of the constructs that made the schema impossible to represent."""

    def to_wire(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "dropped": self.dropped,
            "omitted": self.omitted,
            "reasons": self.reasons,
        }


def _is_finite_number(value: object) -> bool:
    # bool is an int subclass in Python; JSON booleans are not numbers.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_non_negative_integer(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 0
    # JS Number.isInteger(1.0) is true, and json.loads("1.0") is a float here.
    return isinstance(value, float) and value.is_integer() and value >= 0


def _join(path: str, key: str) -> str:
    return key if path == "" else f"{path}.{key}"


def project_input_schema(input_schema: object) -> SchemaProjection:
    """Project an MCP `inputSchema` (arbitrary JSON Schema) onto kohaku's closed `paramsSchema` subset.

    Annotation keywords (`description`, `title`, `default`, ...) and constraints the subset lacks (`format`,
    `pattern`, ...) are dropped and listed in `dropped`. Every object node is closed with
    `additionalProperties: false`. `anyOf` / `oneOf` / `allOf` / `not` / `$ref`, a `type` array, a tuple `items`,
    a malformed keyword value or an unknown keyword make the schema unrepresentable: `omitted` is True and
    `schema` is None. The walk never stops early, so `dropped` and `reasons` are complete and deterministic.
    """
    dropped: list[str] = []
    reasons: list[str] = []
    projected = _project_node(input_schema, "", dropped, reasons, is_root=True)
    omitted = projected is None or len(reasons) > 0
    return SchemaProjection(
        schema=None if omitted else projected, dropped=dropped, omitted=omitted, reasons=reasons
    )


def _project_node(
    node: object, path: str, dropped: list[str], reasons: list[str], *, is_root: bool = False
) -> dict[str, Any] | None:
    if not isinstance(node, dict):
        reasons.append("(root)" if path == "" else path)
        return None
    node_type = node.get("type")
    reasons_before = len(reasons)
    valid_type = isinstance(node_type, str) and node_type in _SCALAR_TYPES

    result: dict[str, Any] = {}
    if valid_type:
        result["type"] = node_type

    # Walk the keywords in the input's own order so `dropped` / `reasons` are deterministic.
    for key in node:
        key_path = _join(path, key)
        if key == "type":
            continue
        if key.startswith("x-") or key in _DROPPED_KEYWORDS:
            dropped.append(key_path)
            continue
        if _is_kept_keyword(key):
            if not _keyword_applies_to(key, node_type):
                # JSON Schema ignores a keyword on a node of another type, so dropping it changes nothing.
                dropped.append(key_path)
                continue
            _project_keyword(key, node[key], key_path, result, dropped, reasons)
            continue
        if key == "enum":
            _project_enum(node[key], key_path, result, reasons)
            continue
        # Unknown or structural keyword (`anyOf`, `$ref`, `not`, a vendor extension, ...).
        reasons.append(key_path)

    # A missing or unusable `type` is reported only when nothing more specific already explains why this node
    # cannot be represented. A tool's arguments are always an object, so the root must be one.
    if (not valid_type or (is_root and node_type != "object")) and len(reasons) == reasons_before:
        reasons.append(_join(path, "type"))
    if node_type == "object" and "additionalProperties" not in result:
        result["additionalProperties"] = False
    return result


def _is_kept_keyword(key: str) -> bool:
    return (
        key in _OBJECT_KEYWORDS
        or key in _NUMBER_KEYWORDS
        or key in _STRING_KEYWORDS
        or key in _ARRAY_KEYWORDS
    )


def _keyword_applies_to(key: str, node_type: object) -> bool:
    if key in _OBJECT_KEYWORDS:
        return node_type == "object"
    if key in _NUMBER_KEYWORDS:
        return node_type in ("number", "integer")
    if key in _STRING_KEYWORDS:
        return node_type == "string"
    return node_type == "array"


def _project_keyword(
    key: str,
    value: object,
    path: str,
    result: dict[str, Any],
    dropped: list[str],
    reasons: list[str],
) -> None:
    if key == "properties":
        if not isinstance(value, dict):
            reasons.append(path)
            return
        properties: dict[str, Any] = {}
        for name in value:
            child = _project_node(value[name], _join(path, name), dropped, reasons)
            if child is not None:
                properties[name] = child
        result["properties"] = properties
    elif key == "required":
        if not isinstance(value, list) or not all(isinstance(entry, str) for entry in value):
            reasons.append(path)
            return
        result["required"] = list(value)
    elif key == "additionalProperties":
        # Only a literal `false` is representable. `true` / a schema object means "extra keys welcome".
        if value is not False:
            reasons.append(path)
            return
        result["additionalProperties"] = False
    elif key in ("minimum", "maximum"):
        if not _is_finite_number(value):
            reasons.append(path)
            return
        result[key] = value
    elif key in ("minLength", "maxLength", "maxItems"):
        if not _is_non_negative_integer(value):
            reasons.append(path)
            return
        result[key] = int(cast("int | float", value))  # validated just above
    elif key == "items":
        # A tuple form (a list of schemas) or a boolean schema has no equivalent in the subset.
        child = _project_node(value, path, dropped, reasons)
        if child is not None:
            result["items"] = child
    else:
        reasons.append(path)


def _project_enum(value: object, path: str, result: dict[str, Any], reasons: list[str]) -> None:
    def primitive(entry: object) -> bool:
        return entry is None or isinstance(entry, (str, bool)) or _is_finite_number(entry)

    if not isinstance(value, list) or not all(primitive(entry) for entry in value):
        reasons.append(path)
        return
    result["enum"] = list(value)
