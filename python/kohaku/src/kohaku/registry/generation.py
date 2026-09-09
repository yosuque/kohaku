"""Building the schema for L1 constrained generation (Port of TS generation.ts).

- A variant (anyOf) per component type. props are derived from the catalog's true schema.
- data $ref is pinned to an enum of the QueryHandle URIs resolved by the SemanticPort, so the LLM
  cannot forge an unknown reference (schema-level enforcement of the reference-passing principle).
- Event payloads are {key,value} pair arrays (strict mode does not allow free-form objects).

Client-local state (state / visibleWhen / emit:"state.set") and two-way binding
(data.bind / control.select) are not put in the generation vocabulary (structural containment).
"""

from __future__ import annotations

import copy
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from .catalog import ResolvedCatalog

_ID_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"

GENERATION_ALWAYS_INCLUDED = ("layout.stack", "presentMarkdown")
"""Components always kept in the generation vocabulary even when candidate narrowing (include_types) is specified.

layout.stack is the root container and presentMarkdown is the terminal of the deterministic fallback;
if either disappears from the vocabulary, the L1 repair loop can no longer hold structurally.
"""


@dataclass(frozen=True)
class GeneratedDraft:
    """A draft decoded from the LLM-generated object (a wire dict before schema validation).

    The TS implementation also does not validate at this stage (the later catalog.validate + Spec parse do),
    so the Python side likewise keeps it as a dict rather than modeling it.
    """

    components: list[dict[str, Any]]
    events: list[dict[str, Any]]


@dataclass(frozen=True)
class GenerationSchema:
    jsonSchema: dict[str, Any]
    """JSON Schema already converted to the provider lowest common denominator (strict-mode compatible)"""
    decode: Callable[[object], GeneratedDraft]
    """LLM-generated object -> draft (null removal / payload pairs -> object)"""


def select_generation_types(
    catalog: ResolvedCatalog, include_types: Sequence[str] | None = None
) -> list[str]:
    """Determine the component types that actually appear in the generation vocabulary (the single source that keeps the schema and prompt vocabularies aligned).

    Decided in the order: exclude generation:"excluded" -> narrow by include_types -> guardrail union ->
    zero-count fallback.
    """
    listed = [d for d in catalog.list() if d.generation != "excluded"]
    if include_types is None:
        return [d.type for d in listed]
    # If none of the specified types exist in the catalog, fall back to all (to avoid an empty vocabulary).
    requested = [d for d in listed if d.type in include_types]
    if len(requested) == 0:
        return [d.type for d in listed]
    allowed = set(include_types) | set(GENERATION_ALWAYS_INCLUDED)
    return [d.type for d in listed if d.type in allowed]


def build_generation_schema(
    catalog: ResolvedCatalog,
    data_refs: list[str],
    include_types: Sequence[str] | None = None,
) -> GenerationSchema:
    included = set(select_generation_types(catalog, include_types))
    variants: list[dict[str, Any]] = []
    for definition in catalog.list():
        if definition.type not in included:
            continue
        props = to_generation_props_schema(definition.propsSchema.json_schema)
        properties: dict[str, Any] = {
            "id": {"type": "string", "pattern": _ID_PATTERN},
            "type": {"const": definition.type},
            "props": props,
        }
        required = ["id", "type", "props"]

        if definition.capabilities.children == "optional":
            properties["children"] = {
                "anyOf": [
                    {"type": "array", "items": {"type": "string", "pattern": _ID_PATTERN}},
                    {"type": "null"},
                ]
            }
            required.append("children")
        if definition.capabilities.data != "none" and len(data_refs) > 0:
            ref_schema = {
                "type": "object",
                "properties": {"$ref": {"type": "string", "enum": list(data_refs)}},
                "required": ["$ref"],
                "additionalProperties": False,
            }
            properties["data"] = (
                ref_schema
                if definition.capabilities.data == "required"
                else {"anyOf": [ref_schema, {"type": "null"}]}
            )
            required.append("data")

        variants.append(
            {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
                "description": f"{definition.type}@{definition.version}: {definition.description}",
            }
        )

    event_schema = {
        "type": "object",
        "properties": {
            "on": {
                "type": "string",
                "description": 'componentId.eventName format (e.g. "table1.rowClick")',
            },
            "emit": {
                "type": "string",
                "enum": ["intent.patch", "intent.replace", "action.invoke"],
            },
            "payload": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"key": {"type": "string"}, "value": {"type": "string"}},
                    "required": ["key", "value"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["on", "emit", "payload"],
        "additionalProperties": False,
    }

    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "components": {"type": "array", "items": {"anyOf": variants}},
            "events": {"type": "array", "items": event_schema},
        },
        "required": ["components", "events"],
        "additionalProperties": False,
    }

    return GenerationSchema(jsonSchema=json_schema, decode=_decode)


def _decode(raw: object) -> GeneratedDraft:
    """Defensive decode: because the schema is not enforced on the prompt-JSON fallback path, an LLM's
    malformed output is thrown as a descriptive Error so the caller (l1_generate) can pick it up as a
    repair issue (rather than a TypeError turning the whole compose into INTERNAL).
    """
    obj = raw if isinstance(raw, dict) else {}
    raw_components = obj.get("components", [])
    if not isinstance(raw_components, list):
        raise ValueError("generated draft components is not an array")
    components: list[dict[str, Any]] = []
    for i, c in enumerate(raw_components):
        if not isinstance(c, dict):
            raise ValueError(f"generated draft components[{i}] is not an object")
        node = strip_nulls(c)
        assert isinstance(node, dict)
        node["props"] = node.get("props") or {}
        components.append(node)
    raw_events = obj.get("events", [])
    if not isinstance(raw_events, list):
        raise ValueError("generated draft events is not an array")
    events: list[dict[str, Any]] = []
    for i, e in enumerate(raw_events):
        if not isinstance(e, dict):
            raise ValueError(f"generated draft events[{i}] is not an object")
        on = e.get("on")
        emit = e.get("emit")
        # An out-of-enum emit is "a string but invalid", so let it through and leave it to the later
        # EventBinding validation. Here we reject only non-strings that would produce a TypeError.
        if not isinstance(on, str):
            raise ValueError(f"generated draft events[{i}].on is not a string")
        if not isinstance(emit, str):
            raise ValueError(f"generated draft events[{i}].emit is not a string")
        raw_payload = e.get("payload")
        payload_pairs = raw_payload if isinstance(raw_payload, list) else []
        payload: dict[str, Any] = {}
        for p in payload_pairs:
            pair = p if isinstance(p, dict) else {}
            payload[str(pair.get("key"))] = pair.get("value")
        events.append({"on": on, "emit": emit, "payload": payload})
    return GeneratedDraft(components=components, events=events)


def to_generation_props_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Deterministic conversion into the schema presented to the LLM (aligned to the provider lowest common denominator for structured output):

    - object: make every property required and turn originally-optional ones into anyOf [orig, null]
      (for OpenAI strict mode; a two-stage approach of removing null after generation and re-validating against the true schema)
    - force additionalProperties: false
    - remove default / $schema (for Gemini responseSchema compatibility)
    """
    result = _walk(copy.deepcopy(schema))
    assert isinstance(result, dict)
    return result


def _walk(node: object) -> object:
    if isinstance(node, list):
        return [_walk(v) for v in node]
    if not isinstance(node, dict):
        return node
    n = dict(node)
    n.pop("default", None)
    n.pop("$schema", None)

    if n.get("type") == "object" and isinstance(n.get("properties"), dict):
        props = n["properties"]
        required = set(n.get("required") or [])
        new_props: dict[str, Any] = {}
        for key, value in props.items():
            transformed = _walk(value)
            new_props[key] = (
                transformed if key in required else {"anyOf": [transformed, {"type": "null"}]}
            )
        n["properties"] = new_props
        n["required"] = list(new_props.keys())
        n["additionalProperties"] = False
        return n

    for key in ("items", "anyOf", "oneOf", "allOf", "prefixItems"):
        if n.get(key) is not None:
            n[key] = _walk(n[key])
    return n


def strip_nulls(value: object) -> object:
    """Remove null-valued properties from the generation result (the "null = omitted" convention). A precursor to re-validation."""
    if isinstance(value, list):
        return [strip_nulls(v) for v in value]
    if isinstance(value, dict):
        return {k: strip_nulls(v) for k, v in value.items() if v is not None}
    return value
