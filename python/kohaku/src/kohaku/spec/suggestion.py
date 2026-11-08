"""Wire shape of a machine-extracted schema suggestion (Port of TS packages/spec-core/src/ports/suggestion.ts).

A single wire-contract type shared across same-layer packages that must not depend on one another: evals
produces it (`kohaku.evals.schema_extraction`), lineage persists it on the promotion snapshot
(`data["suggestion"]`) and records it on `component.schemaSuggested`. Advisory only; never applied without a
human `approve` carrying the final draft.

Differences from TS:
- Each type is a frozen dataclass with `to_wire()` (key order = TS object literal order, None fields omitted),
  so `kohaku.host_core.serialize.to_jsonable` and the lineage payload use one wire shape.
- `SuggestedDraft.queryTemplate` is kept as a plain wire dict (`{"path", "fixedParams"?, "paramMap"?}`) rather
  than lineage's `QueryTemplate`, because spec sits below lineage in the dependency direction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class SuggestedEvent:
    """One event a machine-extracted suggestion believes a promotion candidate emits."""

    name: str
    description: str

    def to_wire(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description}


@dataclass(frozen=True)
class SuggestedDraft:
    """The `draft` a suggestion proposes; structurally identical to lineage's `ComponentDraft`."""

    componentType: str
    version: str
    intentName: str
    description: str
    paramsJsonSchema: Any = None
    """JSON Schema for the props (LLM-extracted or a human-entered draft)."""
    queryTemplate: dict[str, Any] | None = None
    """Data wiring for the promotion Intent: `{"path", "fixedParams"?, "paramMap"?}`."""

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "componentType": self.componentType,
            "version": self.version,
            "intentName": self.intentName,
            "description": self.description,
        }
        if self.paramsJsonSchema is not None:
            out["paramsJsonSchema"] = self.paramsJsonSchema
        if self.queryTemplate is not None:
            out["queryTemplate"] = self.queryTemplate
        return out


@dataclass(frozen=True)
class SchemaSuggestion:
    """A machine-extracted registration proposal for a promotion candidate (advisory only)."""

    draft: SuggestedDraft
    events: list[SuggestedEvent] = field(default_factory=list)
    confidence: float = 0.0
    """The extractor's own 0..1 estimate of how faithfully the proposal reflects the HTML."""
    model: str = ""
    """The model that produced the proposal (LlmPort model id), for the audit trail."""
    extractorId: str = ""
    extractorVersion: str = ""
    """Extractor identity + version, stamped like a rubric so a later prompt change is visible in lineage."""
    suggestedAt: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "draft": self.draft.to_wire(),
            "events": [e.to_wire() for e in self.events],
            "confidence": self.confidence,
            "model": self.model,
            "extractorId": self.extractorId,
            "extractorVersion": self.extractorVersion,
            "suggestedAt": self.suggestedAt,
        }


__all__ = ["SchemaSuggestion", "SuggestedDraft", "SuggestedEvent"]
