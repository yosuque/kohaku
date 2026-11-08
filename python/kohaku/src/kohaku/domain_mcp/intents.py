"""One Intent per read-only MCP tool (port of intents.ts)."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from kohaku.intents import (
    EnumField,
    IntentDef,
    IntentSpec,
    ParamField,
    QueryTemplate,
    define_intent,
    number,
    object_schema,
    string,
)

from .nullable import unwrap_nullable
from .port import McpDomainPort, SkipReport
from .types import McpToolInfo

_SOURCE_PATTERN = re.compile(r"[a-z][a-z0-9_]*")


def _canonical_segment(tool_name: str) -> str:
    """`Get-Orders` -> `get_orders`, `9lives` -> `t_9lives`: a name CanonicalNameSchema accepts as one segment."""
    lowered = re.sub(r"[^a-z0-9_]", "_", tool_name.lower())
    return lowered if re.match(r"[a-z]", lowered) else f"t_{lowered}"


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _field_for(raw_prop: object) -> ParamField | None:
    """The params-DSL field for one scalar `inputSchema` property, or None when the type has no Intent-param form."""
    prop = unwrap_nullable(raw_prop)
    if not isinstance(prop, dict):
        return None
    type_ = prop.get("type")
    if type_ == "string":
        values = prop.get("enum")
        if isinstance(values, list) and len(values) > 0 and all(isinstance(v, str) for v in values):
            return EnumField(values=tuple(values))
        return string()
    if type_ in ("number", "integer"):
        minimum = prop.get("minimum")
        maximum = prop.get("maximum")
        return number(
            integer=type_ == "integer",
            minimum=minimum if _is_number(minimum) else None,
            maximum=maximum if _is_number(maximum) else None,
        )
    return None


def _params_for(tool: McpToolInfo) -> tuple[dict[str, ParamField] | None, str | None]:
    """The params shape for a tool, or `(None, reason)` when the tool cannot be an Intent."""
    properties = tool.input_schema.get("properties")
    props: dict[str, Any] = properties if isinstance(properties, dict) else {}
    required_raw = tool.input_schema.get("required")
    required = set(required_raw) if isinstance(required_raw, list) else set()
    shape: dict[str, ParamField] = {}
    for name, prop in props.items():
        field = _field_for(prop)
        if field is None:
            # An optional parameter we cannot express is simply not settable through an Intent; a required one
            # would make every resolved ref invalid.
            if name in required:
                return None, f'required parameter "{name}" has a type an Intent cannot carry'
            continue
        shape[name] = field if name in required else field.optional()
    for name in required:
        if name not in shape and name not in props:
            return None, f'required parameter "{name}" is not declared in properties'
    return shape, None


def create_mcp_intents(
    port: McpDomainPort,
    *,
    source: str,
    on_skip: Callable[[SkipReport], None] | None = None,
) -> list[IntentDef]:
    """One `IntentDef` per read-only tool of the port.

    The params come from the tool's `inputSchema` (strings, numbers, integers and string enums; other optional
    parameters are left out, and a tool that requires one is skipped, with `on_skip`), `queries` is
    `[{path: tool.name}]` on `source`, and the canonical name is `<source>.<segment>`, where the segment is the
    tool name lowercased with every character outside `[a-z0-9_]` (`-`, `.`, ...) replaced by `_`, and prefixed
    `t_` if it would not start with a letter. Two tools that map to the same canonical name make this raise.
    `source` is the host's query source and must be lowercase letters, digits and underscores, starting with a
    letter.

    Silent limits: an optional parameter of a type an Intent cannot carry (boolean, array, object, a genuine
    union) is left out, so it can never be set through an Intent.

    Actions never get an Intent: a `query://` ref, and so a read capability, can only ever be issued for an
    Intent's resolved refs, which is what keeps a write tool from being read. A hand-written Intent must never
    point at an action op (`port.action_ops`).
    """
    if _SOURCE_PATTERN.fullmatch(source) is None:
        raise ValueError(
            f'create_mcp_intents: source "{source}" must match {_SOURCE_PATTERN.pattern} '
            "to prefix an Intent name"
        )
    intents: list[IntentDef] = []
    names: dict[str, str] = {}
    for name, tool in port.tools.items():
        if name not in port.query_ops:
            continue
        shape, skip = _params_for(tool)
        if shape is None:
            if on_skip is not None:
                on_skip(SkipReport(tool=name, reason=skip or ""))
            continue
        canonical = f"{source}.{_canonical_segment(name)}"
        previous = names.get(canonical)
        if previous is not None:
            raise ValueError(
                f'create_mcp_intents: tools "{previous}" and "{name}" map to the same canonical '
                f'Intent name "{canonical}"'
            )
        names[canonical] = name
        description = tool.description if tool.description is not None else tool.title
        definition = define_intent(
            IntentSpec(
                canonical=canonical,
                description=description if description is not None else tool.name,
                params=object_schema(shape),
                examples=[],
                source=source,
                queries=[QueryTemplate(path=name, paramMap={key: key for key in shape})],
            )
        )
        intents.append(definition.to_intent_def())
    return intents
