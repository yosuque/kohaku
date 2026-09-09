"""Mechanical generation of the MCP intent tools from the Intent catalog (port of packages/host-mcp-apps/src/intent-tools.ts).

In TS the zod raw shape is passed to inputSchema and the SDK converts it to JSON Schema, but Python's mcp SDK
receives JSON Schema directly. So this module converts an ObjectSchema (kohaku.intents' params DSL) into JSON Schema.
Default filling is done by the SDK's zod in TS, but Python's SDK does not, so to_intent fills via params.parse
(centralized coerce) (an intentional difference from TS).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from kohaku.intents import (
    EnumField,
    IntentToolSource,
    NumberField,
    ObjectSchema,
    ParamField,
    StringField,
)
from kohaku.spec import IntentInput, JsonObject


@dataclass(frozen=True)
class IntentToolDef:
    """One intent tool definition passed to attach_kohaku_to_mcp_server (same shape as TS IntentToolDef).

    input_schema is the MCP tool's inputSchema (JSON Schema). to_intent converts the MCP tool arguments into a
    canonical Intent (IntentInput) (with default filling + coerce applied).
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    to_intent: Callable[[JsonObject], IntentInput]


@dataclass(frozen=True)
class IntentToolsOptions:
    name_prefix: str | None = None
    """Tool-name prefix (namespace separation). When given, becomes `<prefix>_<normalized name>`.
    Default is none (only normalization of the canonical name; the canonical is assumed to already have a namespace like `sales.`)."""


_NON_TOOL_NAME_CHARS = re.compile(r"[^A-Za-z0-9_-]+")
_EDGE_UNDERSCORES = re.compile(r"^_+|_+$")


def to_mcp_tool_name(canonical: str, name_prefix: str | None = None) -> str:
    """Normalize a canonical Intent name to the MCP tool naming constraint ([A-Za-z0-9_-]).

    Example: "sales.quarterly_summary" -> "sales_quarterly_summary"
    Unsupported characters (dots, etc.) are folded (runs collapsed) into "_", and edge "_" are dropped.
    """
    base = _NON_TOOL_NAME_CHARS.sub("_", canonical)
    base = _EDGE_UNDERSCORES.sub("", base)
    if name_prefix is not None and name_prefix != "":
        return f"{name_prefix}_{base}"
    return base


def object_schema_to_json_schema(schema: ObjectSchema) -> dict[str, Any]:
    """Convert an Intent params ObjectSchema into an MCP tool inputSchema (JSON Schema).

    - Fields that have a default / are optional are not placed in required (symmetric with TS's zod .default()/.optional()).
    - enum (EnumField) reflects `enum`, and a default reflects `default`, into the JSON Schema
      (the intent-tools test inspects properties[...].enum / default).
    """
    properties: dict[str, Any] = {}
    required: list[str] = []
    for key, field in schema.shape.items():
        properties[key] = _field_to_json_schema(field)
        if not field.has_default and not field.is_optional:
            required.append(key)
    result: dict[str, Any] = {"type": "object", "properties": properties}
    if len(required) > 0:
        result["required"] = required
    return result


def _field_to_json_schema(field: ParamField) -> dict[str, Any]:
    schema: dict[str, Any]
    if isinstance(field, EnumField):
        schema = {"type": "string", "enum": list(field.values)}
    elif isinstance(field, NumberField):
        schema = {"type": "integer" if field.integer else "number"}
        if field.minimum is not None:
            schema["minimum"] = field.minimum
        if field.maximum is not None:
            schema["maximum"] = field.maximum
    elif isinstance(field, StringField):
        schema = {"type": "string"}
        if field.min_length is not None:
            schema["minLength"] = field.min_length
    else:  # pragma: no cover — a safeguard for future type additions
        schema = {}
    if field.has_default:
        schema["default"] = field.default_value
    return schema


def intent_tools_from_catalog(
    defs: list[IntentToolSource] | tuple[IntentToolSource, ...],
    options: IntentToolsOptions | None = None,
) -> list[IntentToolDef]:
    """Mechanically generate the MCP intent tools from the Intent catalog (an array of generic views).

    - input_schema is each Intent's params (ObjectSchema) converted into JSON Schema.
    - to_intent keeps the canonical name as-is (compose's intent path recomputes the hash via finalize_intent).
      Python's SDK does not fill defaults, so to_intent fills defaults + coerces via params.parse.

    Tool names are normalized to the MCP naming constraint, and post-normalization collisions / empty names are
    rejected with an error (deterministic).
    """
    options = options if options is not None else IntentToolsOptions()
    by_tool_name: dict[str, str] = {}  # normalized tool name -> originating canonical (for collision detection)
    tools: list[IntentToolDef] = []
    for source in defs:
        name = to_mcp_tool_name(source.name, options.name_prefix)
        if name == "":
            raise ValueError(f'Cannot generate a valid MCP tool name from Intent "{source.name}"')
        collided = by_tool_name.get(name)
        if collided is not None:
            raise ValueError(
                f'MCP tool name "{name}" collides between Intent "{collided}" and "{source.name}"'
            )
        by_tool_name[name] = source.name
        tools.append(
            IntentToolDef(
                name=name,
                description=source.description,
                input_schema=object_schema_to_json_schema(source.params),
                to_intent=_make_to_intent(source.name, source.params),
            )
        )
    return tools


def _make_to_intent(canonical: str, params: ObjectSchema) -> Callable[[JsonObject], IntentInput]:
    """Bind canonical / params to generate to_intent (avoids late binding of the loop variable)."""

    def to_intent(args: JsonObject) -> IntentInput:
        return IntentInput(canonical=canonical, params=params.parse(args))

    return to_intent
