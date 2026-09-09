"""Contribution of sales-domain-specific components (port of TS: apps/sample-api/src/catalog/contribution.ts).

Delivered via a federated merge with the core catalog (CatalogContribution).
TS's propsSchema is zod, but the Python version writes it with PropsSchema, which treats JSON Schema as canonical.
"""

from __future__ import annotations

from kohaku.registry import ComponentDefinition, PropsSchema, define_component
from kohaku.registry.types import CapabilityDecl, FallbackDecl
from kohaku.spec import CatalogContribution, JsonObject


def _fallback_markdown(_props: JsonObject) -> JsonObject:
    return {"markdown": "(The KPI card is not available on this surface)"}


# Card display of a single KPI. The data reference is 1 row of {label, value, format, note}.
sales_kpi_card: ComponentDefinition = define_component(
    ComponentDefinition(
        type="sales.kpiCard",
        version="1.0.0",
        description=(
            "Card display of a single KPI. The data reference is one row of {label, value, format, note} "
            "(format: currency|percent|number). Use it to highlight a summary or attainment."
        ),
        propsSchema=PropsSchema(
            {
                "type": "object",
                # Specify only when you want to override the data row's label (optional, so not included in required).
                "properties": {"label": {"type": "string"}},
            }
        ),
        capabilities=CapabilityDecl(events=[], data="required", children="none"),
        fallback=FallbackDecl(type="presentMarkdown", map_props=_fallback_markdown),
    )
)


sales_contribution = CatalogContribution(components=[sales_kpi_card])


__all__ = ["sales_contribution", "sales_kpi_card"]
