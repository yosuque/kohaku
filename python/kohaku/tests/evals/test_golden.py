"""Tests for Golden Spec regression (the TS-side packages/evals/test/golden.test.ts as pytest).

Checks the variance-normalized match decision (a pure function) and that the composer's output matches the
expected Spec (deterministic with FakeLlm).
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import ComposeContext, IntentComposeInput
from kohaku.evals import GoldenCase, normalize_for_match, run_golden, specs_match
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    DataShape,
    Intent,
    IntentInput,
    QueryHandle,
    SessionContext,
    parse_spec,
)
from kohaku.storage import FileStoragePort

# Use the same ledger ref as the canonical fixture.
_REF = "query://ledger/sales_summary?fy=2026&groupBy=region&q=3"
_CATALOG = resolve_catalog(core_catalog())


class _GoldenSemantic:
    """A deterministic SemanticPort for golden (describe_shape is None = no automatic sortBy filling)."""

    async def normalize(self, input: Any, ctx: SessionContext) -> IntentInput:
        return IntentInput(canonical="sales.quarterly_summary", params={})

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return QueryHandle(uri=_REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@seed-1"

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        return None


def _raw_draft(ids: tuple[str, str, str, str]) -> dict[str, Any]:
    """An L1 draft conforming to the generation schema (same shape as the TS golden's rawDraft)."""
    r, a, b, c = ids
    return {
        "components": [
            {
                "id": r,
                "type": "layout.stack",
                "props": {"direction": "vertical", "gap": None},
                "children": [a, b, c],
            },
            {
                "id": a,
                "type": "text.heading",
                "props": {"level": 2, "text": "FY2026 Q3 Sales (by Region)"},
            },
            {
                "id": b,
                "type": "presentChart",
                "props": {
                    "kind": "bar",
                    "x": "region",
                    "y": "revenue",
                    "series": None,
                    "stacked": None,
                    "title": None,
                },
                "children": None,
                "data": {"$ref": _REF},
            },
            {
                "id": c,
                "type": "presentSpreadsheet",
                "props": {"editable": False, "columns": None, "sortBy": None, "pageSize": None},
                "children": None,
                "data": {"$ref": _REF},
            },
        ],
        "events": [
            {
                "on": f"{c}.rowClick",
                "emit": "intent.patch",
                "payload": [{"key": "drilldown", "value": "$row.region"}],
            }
        ],
    }


def test_specs_match_normalizes_id_provenance_dataversion(
    example_spec_data: dict[str, Any],
) -> None:
    a = parse_spec(example_spec_data)

    # Even with different IDs, position normalization treats them as identical (also perturb provenance / dataVersion).
    b_components: list[dict[str, Any]] = []
    for comp in example_spec_data["components"]:
        new_comp = dict(comp)
        new_comp["id"] = "root" if comp["id"] == "root" else f"x_{comp['id']}"
        if "children" in comp:
            new_comp["children"] = [f"x_{x}" for x in comp["children"]]
        b_components.append(new_comp)
    b = parse_spec(
        {
            **example_spec_data,
            "dataVersion": "ledger@other-version",
            "provenance": {"tier": "L1", "composedBy": "composer@9.9.9", "cache": "miss"},
            "components": b_components,
            "events": [{**e, "on": f"x_{e['on']}"} for e in example_spec_data["events"]],
        }
    )
    assert specs_match(b, a) is True

    # A difference in props is detected.
    c_components: list[dict[str, Any]] = []
    for comp in example_spec_data["components"]:
        if comp["id"] == "chart1":
            changed = dict(comp)
            changed["props"] = {**comp["props"], "kind": "pie"}
            c_components.append(changed)
        else:
            c_components.append(comp)
    c = parse_spec({**example_spec_data, "components": c_components})
    assert specs_match(c, a) is False


def test_run_golden_composer_output_matches(
    tmp_path: Any, example_spec_data: dict[str, Any]
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        llm = FakeLlm(objects=[_raw_draft(("root", "a", "b", "c"))])
        ctx = ComposeContext(
            catalog=_CATALOG, semantic=_GoldenSemantic(), storage=storage, llm=llm
        )
        # Match the expected value to the catalog-default-filled form (this ctx's describe_shape is None, so
        # automatic sortBy filling does not run).
        normalized = _CATALOG.validate(example_spec_data["components"]).normalized
        expected = parse_spec({**example_spec_data, "components": normalized})

        report = await run_golden(
            [
                GoldenCase(
                    name="sales.quarterly_summary FY2026 Q3 region",
                    input=IntentComposeInput(
                        intent=IntentInput(
                            canonical="sales.quarterly_summary",
                            params={"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
                        )
                    ),
                    expected=expected,
                )
            ],
            ctx,
        )
        assert report.pass_ is True, (report.cases[0].expected, report.cases[0].actual)

    asyncio.run(run())


def test_normalize_for_match_is_deterministic(example_spec_data: dict[str, Any]) -> None:
    spec = parse_spec(example_spec_data)
    assert normalize_for_match(spec) == normalize_for_match(parse_spec(example_spec_data))
