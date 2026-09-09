"""The GUI facet descriptor (port of facet-view.ts).

Framework-neutral JSON, consumed by sample-web's FacetPanel. Derived from defineIntent's facets declaration +
params, and emitted to facet-views.json by codegen. The wire shape matches TS (field names stay camelCase;
to_wire() may omit allowEmpty). `label` fields are canonical (English); the optional `labels` maps carry
locale overlays (locale → label, e.g. {"ja": "地域"}) and are emitted only when declared.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class FacetViewEntry:
    key: str
    label: str
    control: Literal["select", "radio", "number"]
    valueType: Literal["number", "string"]
    """Derived from Zod's coerce. The single source of the client coerce (whether "2026" → 2026)."""
    options: list[dict[str, Any]]
    labels: dict[str, str] | None = None
    """Locale overlays for label."""
    allowEmpty: str | None = None
    """emptyLabel. Present ⇔ clearable (all regions, full year, etc.)."""
    allowEmptyLabels: dict[str, str] | None = None
    """Locale overlays for allowEmpty. Present only when allowEmpty is."""

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "key": self.key,
            "label": self.label,
        }
        if self.labels is not None:
            out["labels"] = self.labels
        out["control"] = self.control
        out["valueType"] = self.valueType
        out["options"] = self.options
        if self.allowEmpty is not None:
            out["allowEmpty"] = self.allowEmpty
            if self.allowEmptyLabels is not None:
                out["allowEmptyLabels"] = self.allowEmptyLabels
        return out


@dataclass(frozen=True)
class FacetView:
    intent: str
    label: str
    facets: list[FacetViewEntry]
    labels: dict[str, str] | None = None
    """Locale overlays for label (e.g. {"ja": "四半期サマリー"})."""

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "intent": self.intent,
            "label": self.label,
        }
        if self.labels is not None:
            out["labels"] = self.labels
        out["facets"] = [facet.to_wire() for facet in self.facets]
        return out
