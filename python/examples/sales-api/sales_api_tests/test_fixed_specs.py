"""Wiring test for the L0 fixed Specs (corresponds to TS: apps/sample-api/src/intents/fixed-specs.ts).

The standard views (quarterly_summary / kpi_overview / records / target_attainment) are deterministically generated
by a fixed template without going through the LLM, so compose's provenance.tier == "L0". It also pins, as a pair,
that an Intent not in fixedSpecs (trend) goes to L1 generation (does not become L0).
"""

from __future__ import annotations

import asyncio

from kohaku.composer import IntentComposeInput, compose
from kohaku.spec import IntentInput, JsonObject, UISpec
from kohaku.storage import MemoryStoragePort
from sales_api.app import create_app
from sales_api.authz_port import create_hmac_authz_port
from sales_api.fake_llm import create_deterministic_fake_llm


async def _compose(canonical: str, params: JsonObject) -> UISpec:
    storage = MemoryStoragePort()
    authz = create_hmac_authz_port("test-secret")
    llm = create_deterministic_fake_llm()
    app = await create_app(llm=llm, storage=storage, authz=authz)
    result = await compose(
        IntentComposeInput(intent=IntentInput(canonical=canonical, params=params)),
        app.compose_ctx,
    )
    return result.spec


class TestFixedSpecsAreL0:
    def test_quarterly_summary_is_l0(self) -> None:
        spec = asyncio.run(
            _compose("sales.quarterly_summary", {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"})
        )
        assert spec.provenance.tier == "L0"
        # The per-region summary has an intent.patch event for row-click drilldown.
        assert any(e.emit == "intent.patch" for e in spec.events)

    def test_quarterly_summary_cross_filter_is_l0(self) -> None:
        # When region is specified, it becomes the cross-filter (data.bind + control.select) L0 template.
        spec = asyncio.run(
            _compose(
                "sales.quarterly_summary",
                {"fiscalYear": 2026, "quarter": 3, "groupBy": "region", "region": "apac"},
            )
        )
        assert spec.provenance.tier == "L0"
        # Carries the initial value of the client-local state region over into the delivered Spec.
        assert spec.state is not None and spec.state.get("region") == "apac"
        # filter change -> state.set(region) is wired (because post_process normalizes component IDs, we judge by
        # emit + payload.key rather than an exact match on `on`).
        assert any(
            e.emit == "state.set" and e.payload.get("key") == "region" for e in spec.events
        )
        # There is a part with bind (data.bind) (re-resolution without a compose round-trip).
        assert any(c.data is not None and c.data.bind is not None for c in spec.components)

    def test_kpi_overview_is_l0_with_four_cards(self) -> None:
        spec = asyncio.run(_compose("sales.kpi_overview", {"fiscalYear": 2026, "quarter": 3}))
        assert spec.provenance.tier == "L0"
        # kpi_overview has 4 KPI cards (swapping the metric of the kpi query).
        assert sum(1 for c in spec.components if c.type == "sales.kpiCard") == 4

    def test_records_is_l0_with_note_dialog(self) -> None:
        spec = asyncio.run(
            _compose("sales.records", {"fiscalYear": 2026, "quarter": 2, "region": "apac", "limit": 50})
        )
        assert spec.provenance.tier == "L0"
        # The note dialog (overlay.dialog + presentForm) + the noteOpen initial state.
        assert any(c.type == "overlay.dialog" for c in spec.components)
        assert spec.state is not None and spec.state.get("noteOpen") is False
        # Write loop: form submit -> action.invoke (annotate; payload has note and refs).
        assert any(
            e.emit == "action.invoke" and "note" in e.payload and "refs" in e.payload
            for e in spec.events
        )

    def test_target_attainment_is_l0(self) -> None:
        spec = asyncio.run(_compose("sales.target_attainment", {"fiscalYear": 2026, "quarter": 2}))
        assert spec.provenance.tier == "L0"
        # The KPI card (refs[1]) + the target-vs-actual chart (refs[0]).
        assert any(c.type == "sales.kpiCard" for c in spec.components)
        assert any(c.type == "presentChart" for c in spec.components)


class TestNonFixedIntentsStayL1:
    def test_trend_is_not_l0(self) -> None:
        # trend is not in fixedSpecs, so it goes to L1 generation (the deterministic pseudo LLM returns an L1 draft).
        spec = asyncio.run(_compose("sales.trend", {"fiscalYear": 2026, "metric": "revenue"}))
        assert spec.provenance.tier != "L0"
