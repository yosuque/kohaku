"""A `DataShape` from a tool's `outputSchema` (port of shape.ts).

Pinned to the TS implementation by the cross-language golden fixture (`domainMcp.shape`).
"""

from __future__ import annotations

from typing import Any

from kohaku.spec import DataShape, DataShapeColumn


def _row_schema_of(output_schema: dict[str, Any]) -> dict[str, Any] | None:
    """The item schema of the list an `outputSchema` describes (the schema twin of tabular.find_row_list)."""

    def items_of(schema: object) -> dict[str, Any] | None:
        if not isinstance(schema, dict) or schema.get("type") != "array":
            return None
        items = schema.get("items")
        return items if isinstance(items, dict) else None

    if output_schema.get("type") == "array":
        return items_of(output_schema)
    properties = output_schema.get("properties")
    if not isinstance(properties, dict):
        return None
    rows = items_of(properties.get("rows"))
    if rows is not None:
        return rows
    if len(properties) == 1:
        return items_of(next(iter(properties.values())))
    return None


def _column_of(name: str, prop: object) -> DataShapeColumn | None:
    if not isinstance(prop, dict):
        return None
    type_ = prop.get("type")
    if type_ == "string":
        if prop.get("format") in ("date", "date-time"):
            return DataShapeColumn(name=name, type="date", role="time")
        return DataShapeColumn(name=name, type="string", role="dimension")
    if type_ in ("number", "integer"):
        return DataShapeColumn(name=name, type="number", role="measure")
    if type_ == "boolean":
        return DataShapeColumn(name=name, type="boolean")
    return None


def shape_from_output_schema(output_schema: object) -> DataShape | None:
    """Build a `DataShape` (column names, types and roles, no row data) from a tool's `outputSchema`: `string`
    is a dimension, `number` / `integer` a measure, and a `string` with format `date` / `date-time` a time
    column. Properties of any other type (nested objects, arrays) are left out. Returns None when there is no
    `outputSchema` or it does not describe a list of objects."""
    if not isinstance(output_schema, dict):
        return None
    row = _row_schema_of(output_schema)
    if row is None or not isinstance(row.get("properties"), dict):
        return None
    columns: list[DataShapeColumn] = []
    for name, prop in row["properties"].items():
        column = _column_of(name, prop)
        if column is not None:
            columns.append(column)
    return DataShape(columns=columns) if columns else None
