"""Common envelope for tabular data and data-shape metadata (port of TS tabular.ts)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from .models import JsonObject

type ColumnType = Literal["string", "number", "boolean", "date"]


class TabularColumn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    key: str
    label: str | None = None
    type: ColumnType

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"key": self.key}
        if self.label is not None:
            out["label"] = self.label
        out["type"] = self.type
        return out


class TabularData(BaseModel):
    """Common envelope for tabular data that data-binding returns and the renderer consumes.

    Carries a dataVersion, so a mismatch (STALE_VERSION) against the Spec's dataVersion can be detected.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    columns: list[TabularColumn]
    rows: list[JsonObject]
    dataVersion: str
    total: int | None = None
    nextCursor: str | None = None
    """Opaque cursor for the next page of server-side paging. If returned, it means "there is more"."""

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "columns": [c.to_wire() for c in self.columns],
            "rows": self.rows,
            "dataVersion": self.dataVersion,
        }
        if self.total is not None:
            out["total"] = self.total
        if self.nextCursor is not None:
            out["nextCursor"] = self.nextCursor
        return out


class DataShapeColumn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    name: str
    type: ColumnType
    role: Literal["dimension", "measure", "time"] | None = None


class DataShape(BaseModel):
    """Metadata for the "shape" of a query result. Contains no row data (the water), only column information (the plumbing diagram).

    Used by composer's chart-kind rule and props filling (upholding the reference-passing principle).
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    columns: list[DataShapeColumn]
    rowCountHint: int | None = None
