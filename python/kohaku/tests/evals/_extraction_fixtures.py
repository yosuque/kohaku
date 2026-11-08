"""Shared fixtures for the schema extractor tests (a helper module not collected by pytest)."""

from __future__ import annotations

from typing import Any

from kohaku.evals import SchemaExtractionInput

HTML = (
    "<!DOCTYPE html><html><head><title>Sales calendar heatmap</title></head><body><div id=hm></div><script>"
    "window.kohaku.fetchData('query://sales/trend?fy=2026&granularity=month&metric=revenue').then(function(d){"
    "document.getElementById('hm').textContent=d.rows.length+' months';"
    "window.kohaku.emit('cellSelected',{month:d.rows[0].month});window.kohaku.ready();});"
    "</script></body></html>"
)

OUTPUT: dict[str, Any] = {
    "componentType": "sales.calendarHeatmap",
    "intentName": "sales.calendar_heatmap",
    "description": "Display sales as a monthly calendar heatmap",
    "paramsJsonSchema": {
        "type": "object",
        "properties": {"fiscalYear": {"type": "integer", "default": 2026}},
    },
    "queryTemplate": {
        "path": "trend",
        "fixedParams": {"metric": "revenue", "granularity": "month"},
        "paramMap": {"fiscalYear": "fy"},
    },
    "events": [{"name": "cellSelected", "description": "A month cell was clicked"}],
    "confidence": 0.85,
}

INPUT = SchemaExtractionInput(html=HTML, request="Sales as a calendar heatmap", namespace="sales")

FINAL: dict[str, Any] = {
    "componentType": "sales.gaugeDial",
    "version": "1.0.0",
    "intentName": "sales.gauge_dial",
    "description": "Show attainment as a dial",
    "paramsJsonSchema": {"type": "object", "properties": {"target": {"type": "number"}}},
}
SUGGESTED: dict[str, Any] = {**FINAL, "componentType": "sales.gauge", "description": "gauge"}
