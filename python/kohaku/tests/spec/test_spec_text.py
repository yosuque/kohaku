"""Tests for spec_to_text (the text fallback summary of a UI Spec).

The definition site was moved from host_mcp/fallback.py to the spec layer (spec_text.py) (the same shape as
spec-text.ts). This pins that the output is byte-unchanged (a move only) and that host_mcp provides a
backward-compatible re-export (the same function object).
"""

from __future__ import annotations

from typing import Any

from kohaku.spec import IntentInput, UISpec, finalize_intent, spec_to_text


def _spec(components: list[dict[str, Any]]) -> UISpec:
    intent = finalize_intent(IntentInput(canonical="sales.trend", params={}))
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": intent.to_wire(),
            "dataVersion": "x",
            "components": components,
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


def test_representative_spec_text_is_unchanged() -> None:
    """The text summary of a representative Spec matches a known string (output byte-unchanged before/after the move)."""
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["h", "c"]},
            {"id": "h", "type": "text.heading", "props": {"level": 2, "text": "Sales"}},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": ["revenue", "profit"]},
                "data": {"$ref": "query://s/p?a=1"},
            },
        ]
    )
    expected = "\n".join(
        [
            "## Sales",
            "[Chart: line] revenue, profit by month (data ref: `query://s/p?a=1`)",
            "",
            "*(intent: `sales.trend` / tier: L0 / cache: miss. "
            "On UI-capable hosts the same Spec is rendered by the shared renderer.)*",
        ]
    )
    assert spec_to_text(spec) == expected


def test_host_mcp_reexports_same_function_object() -> None:
    """host_mcp re-exports the spec layer's spec_to_text for backward compatibility (the same object)."""
    import kohaku.host_mcp as host_mcp
    from kohaku.host_mcp.fallback import spec_to_text as fallback_spec_to_text

    assert fallback_spec_to_text is spec_to_text
    assert host_mcp.spec_to_text is spec_to_text
