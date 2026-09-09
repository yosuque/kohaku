"""A deterministic pseudo LLM (for demos / CI. Selected with KOHAKU_LLM_PROVIDER=fake).

A test provider on the example (sample) side, for passing the conformance black-box check
(`node cli/bin/kohaku.js conformance --rest ...`) without a real LLM. A Python-example-specific addition not present in
the TS sample (TS assumes a local ollama — docs/user-guide.md).

It extracts the "enum of allowed $refs" from the L1 generation request's schema, and deterministically assembles and
returns a minimal draft of a heading + table (with a rowClick event). Because the same input -> the same draft, cache
determinism (REST-CMP-002) also holds as-is.
"""

from __future__ import annotations

from typing import Any

from kohaku.llm import FakeLlm, GenerateObjectRequest, JsonSchema


def _allowed_refs(req: GenerateObjectRequest) -> list[str]:
    """Looks up the enum of data.$ref from the generation schema (the output of build_generation_schema)."""
    schema = req.schema
    if not isinstance(schema, JsonSchema):
        return []
    try:
        variants = schema.json_schema["properties"]["components"]["items"]["anyOf"]
        for variant in variants:
            data = variant.get("properties", {}).get("data")
            if data is None:
                continue
            node = data.get("anyOf", [data])[0] if "anyOf" in data else data
            enum = node.get("properties", {}).get("$ref", {}).get("enum")
            if isinstance(enum, list) and len(enum) > 0:
                return [str(v) for v in enum]
    except (KeyError, TypeError, IndexError):
        return []
    return []


def _draft(req: GenerateObjectRequest) -> dict[str, Any]:
    refs = _allowed_refs(req)
    components: list[dict[str, Any]] = [
        {"id": "root", "type": "layout.stack", "props": {}, "children": ["h1", "t1"]},
        {"id": "h1", "type": "text.heading", "props": {"level": 2, "text": "Sales view"}},
    ]
    events: list[dict[str, Any]] = []
    if refs:
        components.append(
            {"id": "t1", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": refs[0]}}
        )
        events.append(
            {
                "on": "t1.rowClick",
                "emit": "intent.patch",
                "payload": [{"key": "drilldown", "value": "$row.region"}],
            }
        )
    else:
        components.append(
            {"id": "t1", "type": "presentMarkdown", "props": {"markdown": "(no data reference)"}}
        )
    return {"components": components, "events": events}


def create_deterministic_fake_llm() -> FakeLlm:
    """A FakeLlm that returns a deterministic draft for L1 requests (the text path = L2 is not supported)."""
    return FakeLlm(objects=_draft)
