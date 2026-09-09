"""Validation and normalization of the props schema (JSON Schema).

In the TS implementation zod is the "true schema" and JSON Schema is derived, but in Python the
language-neutral JSON Schema is the source of truth (coreCatalog is a TS export, custom parts are
author-defined), and this module validates with the same semantics as zod's safeParse:

- **strip**: keys not in the schema are silently dropped (not an error even with additionalProperties:false —
  because the catalog's props schemas are written with zod's default = strip)
- **default filling**: a property with a "default" is filled with the default when the key is missing
  (zod's toJSONSchema lists default-bearing fields in required too, but safeParse fills a missing one with
   the default — this reproduces that behavior)
- **union (anyOf)**: try in declaration order and take the first branch that succeeds (same as zod union)
- unsupported structures are accepted (a total conversion — the same idea as from-json-schema.ts's z.unknown() fallback)

The supported keywords are those zod's toJSONSchema actually emits for the core catalog:
type / enum / const / anyOf / properties / required / additionalProperties / items /
minLength / maxLength / pattern / minimum / maximum / exclusiveMinimum / exclusiveMaximum /
minItems / maxItems / default / $schema.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


class PropsValidationError(Exception):
    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path or '(root)'}: {message}")
        self.path = path


@dataclass(frozen=True)
class PropsParseResult:
    ok: bool
    value: dict[str, Any] | None = None
    """On success: normalized props with default filling + unknown-key stripping applied"""
    error: str | None = None


class PropsSchema:
    """A props validator with the JSON Schema as source of truth (zod-strip semantics)."""

    def __init__(self, json_schema: dict[str, Any]) -> None:
        if not isinstance(json_schema, dict):  # runtime defense (against type spoofing)
            raise TypeError("propsSchema must be a JSON Schema (dict)")
        self.json_schema = json_schema

    def safe_parse(self, props: object) -> PropsParseResult:
        try:
            value = _validate(self.json_schema, props, "")
        except PropsValidationError as e:
            return PropsParseResult(ok=False, error=str(e))
        if not isinstance(value, dict):
            return PropsParseResult(ok=False, error="props must be an object")
        return PropsParseResult(ok=True, value=value)


def props_schema_from_json_schema(schema: object) -> PropsSchema:
    """A total conversion that reconstructs a PropsSchema from a JSON Schema (equivalent to from-json-schema.ts).

    A non-object / missing schema falls back to loose "arbitrary key -> arbitrary value" validation and
    does not throw at publish / startup time.
    """
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return PropsSchema({"type": "object", "properties": {}})
    return PropsSchema(schema)


def _is_number(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _type_of(v: object) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _validate(schema: object, value: object, path: str) -> object:
    """Validate against the schema and return the normalized (strip + default filling) value."""
    if not isinstance(schema, dict):
        return value  # unknown structures are accepted (total conversion)

    if "anyOf" in schema:
        branches = schema["anyOf"]
        if isinstance(branches, list):
            errors: list[str] = []
            for branch in branches:
                try:
                    return _validate(branch, value, path)
                except PropsValidationError as e:
                    errors.append(str(e))
            raise PropsValidationError(path, f"does not match any union branch: {'; '.join(errors)}")

    if "const" in schema and value != schema["const"]:
        raise PropsValidationError(path, f"does not match const {schema['const']!r}")

    if "enum" in schema:
        allowed = schema["enum"]
        if isinstance(allowed, list) and value not in allowed:
            raise PropsValidationError(path, f"value not in enum {allowed!r}: {value!r}")

    schema_type = schema.get("type")
    if schema_type == "object" or (schema_type is None and "properties" in schema):
        return _validate_object(schema, value, path)
    if schema_type == "array":
        return _validate_array(schema, value, path)
    if schema_type == "string":
        return _validate_string(schema, value, path)
    if schema_type in ("number", "integer"):
        return _validate_number(schema, value, path, integer=schema_type == "integer")
    if schema_type == "boolean":
        if not isinstance(value, bool):
            raise PropsValidationError(path, f"expected boolean (actual: {_type_of(value)})")
        return value
    if schema_type == "null":
        if value is not None:
            raise PropsValidationError(path, f"expected null (actual: {_type_of(value)})")
        return value
    return value  # no type specified / unknown type is accepted


def _validate_object(schema: dict[str, Any], value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PropsValidationError(path, f"expected object (actual: {_type_of(value)})")
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return dict(value)  # if properties is unknown, pass through
    required = schema.get("required")
    required_set = set(required) if isinstance(required, list) else set()

    out: dict[str, Any] = {}
    for key, prop_schema in properties.items():
        prop_path = f"{path}.{key}" if path else key
        if key in value:
            out[key] = _validate(prop_schema, value[key], prop_path)
        elif isinstance(prop_schema, dict) and "default" in prop_schema:
            # zod .default(): fill a missing key with the default (takes precedence over required listing)
            out[key] = prop_schema["default"]
        elif key in required_set:
            raise PropsValidationError(prop_path, "missing required property")
    # Keys not in the schema are stripped (zod's default behavior). Not an error.
    return out


def _validate_array(schema: dict[str, Any], value: object, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise PropsValidationError(path, f"expected array (actual: {_type_of(value)})")
    min_items = schema.get("minItems")
    if isinstance(min_items, int) and len(value) < min_items:
        raise PropsValidationError(path, f"item count is below minimum {min_items} ({len(value)})")
    max_items = schema.get("maxItems")
    if isinstance(max_items, int) and len(value) > max_items:
        raise PropsValidationError(path, f"item count exceeds maximum {max_items} ({len(value)})")
    items = schema.get("items")
    if items is None:
        return list(value)
    return [_validate(items, v, f"{path}[{i}]") for i, v in enumerate(value)]


def _validate_string(schema: dict[str, Any], value: object, path: str) -> str:
    if not isinstance(value, str):
        raise PropsValidationError(path, f"expected string (actual: {_type_of(value)})")
    min_length = schema.get("minLength")
    if isinstance(min_length, int) and len(value) < min_length:
        raise PropsValidationError(path, f"length is below minimum {min_length}")
    max_length = schema.get("maxLength")
    if isinstance(max_length, int) and len(value) > max_length:
        raise PropsValidationError(path, f"length exceeds maximum {max_length}")
    pattern = schema.get("pattern")
    if isinstance(pattern, str) and re.search(pattern, value) is None:
        raise PropsValidationError(path, f"does not match pattern {pattern}")
    return value


def _validate_number(
    schema: dict[str, Any], value: object, path: str, *, integer: bool
) -> int | float:
    if not _is_number(value):
        raise PropsValidationError(path, f"expected number (actual: {_type_of(value)})")
    assert isinstance(value, (int, float))
    if integer and isinstance(value, float) and not value.is_integer():
        raise PropsValidationError(path, f"expected integer (actual: {value})")
    minimum = schema.get("minimum")
    if _is_number(minimum) and value < minimum:  # type: ignore[operator]
        raise PropsValidationError(path, f"below minimum {minimum}")
    maximum = schema.get("maximum")
    if _is_number(maximum) and value > maximum:  # type: ignore[operator]
        raise PropsValidationError(path, f"exceeds maximum {maximum}")
    exclusive_min = schema.get("exclusiveMinimum")
    if _is_number(exclusive_min) and value <= exclusive_min:  # type: ignore[operator]
        raise PropsValidationError(path, f"expected a value greater than {exclusive_min}")
    exclusive_max = schema.get("exclusiveMaximum")
    if _is_number(exclusive_max) and value >= exclusive_max:  # type: ignore[operator]
        raise PropsValidationError(path, f"expected a value less than {exclusive_max}")
    return value
