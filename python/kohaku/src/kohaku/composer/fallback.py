"""Deterministic fallback Spec (port of TS fallback.ts).

When L1 is exhausted and L2 is not permitted, display a summary of the Intent using only presentMarkdown,
without using the LLM at all.
"""

from __future__ import annotations

from typing import Literal

from kohaku.spec import SPEC_VERSION, Intent, UISpec, canonical_stringify


def build_fallback_spec(
    *,
    intent: Intent,
    data_version: str,
    reason: str,
    composed_by: str,
    cache: Literal["hit", "miss", "bypass", "fixated"] = "miss",
    from_tier: Literal["L1", "L2"] = "L1",
) -> UISpec:
    """from_tier is the tier that actually failed. It is reflected in both provenance.tier and fallback.from."""
    markdown = "\n".join(
        [
            "### Could not render this request",
            "",
            f"Requested intent: `{intent.canonical}`",
            "",
            "```json",
            canonical_stringify(intent.params),
            "```",
            "",
            f"Reason: {reason}",
        ]
    )
    return UISpec.model_validate(
        {
            "kohaku": SPEC_VERSION,
            "intent": intent.to_wire(),
            "dataVersion": data_version,
            "components": [
                {
                    "id": "root",
                    "type": "layout.stack",
                    "props": {"direction": "vertical", "gap": "md"},
                    "children": ["md1"],
                },
                {"id": "md1", "type": "presentMarkdown", "props": {"markdown": markdown}},
            ],
            "events": [],
            "provenance": {
                "tier": from_tier,
                "composedBy": composed_by,
                "cache": cache,
                "fallback": {"from": from_tier, "reason": reason, "kind": "generation"},
            },
        }
    )
