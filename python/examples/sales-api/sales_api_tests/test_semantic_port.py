"""Tests for SemanticPort (port of TS: apps/sample-api/test/semantic-port.test.ts + GUI normalization).

Checks normalizeNl's provider-error vs fallback-mismatch classification / fiscal-period computation / clock-injection determinization of the NL
prompt / deterministic normalization of GUI actions (view.select, drilldown) / resolve_query, describe_shape.
Does not use an LLM; stubs LlmPort.
"""

from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from kohaku.llm import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextRequest,
    GenerateTextResult,
    LlmError,
    LlmErrorCode,
    LlmUsage,
)
from kohaku.spec import (
    GuiAction,
    IntentInput,
    NLQuery,
    QueryHandle,
    SessionContext,
    finalize_intent,
)
from sales_api.domain import SalesRepo
from sales_api.intents_catalog import IntentCatalog
from sales_api.semantic_port import create_semantic_port, fiscal_period_of

CTX = SessionContext(surface="web", locale="ja")

_USAGE = LlmUsage(input_tokens=0, output_tokens=0)


class _ThrowingLlm:
    provider = "stub"
    model_id = "stub"

    def __init__(self, code: LlmErrorCode) -> None:
        self._code = code

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        raise LlmError(self._code, f"stub {self._code}")

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        raise LlmError(self._code, f"stub {self._code}")


class _FixedLlm:
    provider = "stub"
    model_id = "stub"

    def __init__(self, obj: object) -> None:
        self._obj = obj

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        return GenerateObjectResult(object=self._obj, usage=_USAGE, model="stub")

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        return GenerateTextResult(text="", usage=_USAGE)


class _CapturingLlm:
    provider = "stub"
    model_id = "stub"

    def __init__(self) -> None:
        self.system: str | None = None

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        self.system = req.system
        return GenerateObjectResult(
            object={"intent": "sales.kpi_overview", "params": {}}, usage=_USAGE, model="stub"
        )

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        return GenerateTextResult(text="", usage=_USAGE)


def _make_port(llm: object) -> object:
    cat = IntentCatalog()
    return create_semantic_port(repo=SalesRepo(), catalog_for=lambda _t: cat, llm=llm)  # type: ignore[arg-type]


class TestNormalizeNlErrorClassification:
    """The custom fallback is limited to "a normal response that does not match the intent"."""

    def test_provider_error_propagates(self) -> None:
        port = _make_port(_ThrowingLlm("PROVIDER"))
        with pytest.raises(LlmError):
            asyncio.run(port.normalize(NLQuery(kind="nl", text="売上を見せて"), CTX))  # type: ignore[attr-defined]

    def test_aborted_propagates(self) -> None:
        port = _make_port(_ThrowingLlm("ABORTED"))
        with pytest.raises(LlmError):
            asyncio.run(port.normalize(NLQuery(kind="nl", text="売上を見せて"), CTX))  # type: ignore[attr-defined]

    def test_config_propagates(self) -> None:
        port = _make_port(_ThrowingLlm("CONFIG"))
        with pytest.raises(LlmError):
            asyncio.run(port.normalize(NLQuery(kind="nl", text="売上を見せて"), CTX))  # type: ignore[attr-defined]

    def test_invalid_output_falls_back_to_custom(self) -> None:
        port = _make_port(_ThrowingLlm("INVALID_OUTPUT"))
        out = asyncio.run(
            port.normalize(NLQuery(kind="nl", text="売上をカレンダーヒートマップで"), CTX)  # type: ignore[attr-defined]
        )
        assert out.canonical == "sales.custom"
        assert out.params["request"] == "売上をカレンダーヒートマップで"

    def test_valid_response_failing_params_falls_back_to_custom(self) -> None:
        # request missing -> normalize_params("sales.custom", {}) is None -> to the explicit fallback.
        port = _make_port(_FixedLlm({"intent": "sales.custom", "params": {}}))
        out = asyncio.run(port.normalize(NLQuery(kind="nl", text="自由な可視化"), CTX))  # type: ignore[attr-defined]
        assert out.canonical == "sales.custom"
        assert out.params["request"] == "自由な可視化"

    def test_valid_known_intent_happy_path(self) -> None:
        port = _make_port(_FixedLlm({"intent": "sales.trend", "params": {"metric": "units"}}))
        out = asyncio.run(port.normalize(NLQuery(kind="nl", text="販売数の推移"), CTX))  # type: ignore[attr-defined]
        assert out.canonical == "sales.trend"
        assert out.params["metric"] == "units"


class TestFiscalPeriodOf:
    """Fiscal-period computation (starts in April; Q1=4-6/Q2=7-9/Q3=10-12/Q4=1-3)."""

    @pytest.mark.parametrize(
        ("date", "fy", "q"),
        [
            (datetime(2026, 6, 30), 2026, 1),
            (datetime(2026, 7, 1), 2026, 2),
            (datetime(2026, 9, 30), 2026, 2),
            (datetime(2026, 10, 1), 2026, 3),
            (datetime(2027, 1, 15), 2026, 4),
            (datetime(2027, 3, 31), 2026, 4),
            (datetime(2027, 4, 1), 2027, 1),
        ],
    )
    def test_boundaries(self, date: datetime, fy: int, q: int) -> None:
        p = fiscal_period_of(date)
        assert p.fiscal_year == fy
        assert p.quarter == q


class TestNlPromptClock:
    """The fiscal period of the NL normalization prompt (determinized by clock injection). The fixed wording is character-identical to TS."""

    def _system_at(self, now: datetime) -> str:
        cap = _CapturingLlm()
        cat = IntentCatalog()
        port = create_semantic_port(
            repo=SalesRepo(), catalog_for=lambda _t: cat, llm=cap, now=lambda: now
        )
        asyncio.run(port.normalize(NLQuery(kind="nl", text="今四半期のサマリー"), CTX))
        assert cap.system is not None
        return cap.system

    def test_fy2026_q2(self) -> None:
        system = self._system_at(datetime(2026, 7, 12))
        assert '"this period"/"this fiscal year" (今期/今年度) = fiscalYear=2026' in system
        assert '"this quarter" (今四半期) = quarter=2 (now 2026-7)' in system
        assert "FY2026 = 2026-04 to 2027-03" in system
        assert '"last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025' in system

    def test_quarter_boundary(self) -> None:
        assert '"this quarter" (今四半期) = quarter=1 (now 2026-6)' in self._system_at(datetime(2026, 6, 30))
        assert '"this quarter" (今四半期) = quarter=2 (now 2026-7)' in self._system_at(datetime(2026, 7, 1))

    def test_year_boundary(self) -> None:
        system = self._system_at(datetime(2027, 1, 15))
        assert '"this period"/"this fiscal year" (今期/今年度) = fiscalYear=2026' in system
        assert '"this quarter" (今四半期) = quarter=4 (now 2027-1)' in system
        assert '"last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025' in system

    def test_clamps_fiscal_year_above_seed_range(self) -> None:
        """May 2027 = FY2027 (outside the seed range). The current fiscal year clamps to FY2026 and the previous year to FY2025."""
        system = self._system_at(datetime(2027, 5, 1))
        assert '"this period"/"this fiscal year" (今期/今年度) = fiscalYear=2026' in system
        assert "FY2026 = 2026-04 to 2027-03" in system
        assert '"last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025' in system
        # The quarter and calendar year/month are not rounded and show the real date (only fiscalYear is clamped).
        assert '"this quarter" (今四半期) = quarter=1 (now 2027-5)' in system

    def test_clamps_fiscal_year_below_seed_range(self) -> None:
        """June 2024 = FY2024 (below the seed range). Both the current and previous fiscal year clamp to FY2025."""
        system = self._system_at(datetime(2024, 6, 1))
        assert '"this period"/"this fiscal year" (今期/今年度) = fiscalYear=2025' in system
        assert "FY2025 = 2025-04 to 2026-03" in system
        assert '"last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025' in system
        assert '"this quarter" (今四半期) = quarter=1 (now 2024-6)' in system


class TestGuiNormalization:
    """Deterministic normalization of GUI actions (does not pass through the LLM)."""

    def test_view_select_merges_facets(self) -> None:
        port = _make_port(_FixedLlm({}))
        out = asyncio.run(
            port.normalize(  # type: ignore[attr-defined]
                GuiAction(
                    kind="gui",
                    action="view.select",
                    params={"intent": "sales.trend", "metric": "units"},
                ),
                CTX,
            )
        )
        assert out.canonical == "sales.trend"
        assert out.params == {"metric": "units", "granularity": "month"}

    def test_facet_change_merges_with_current(self) -> None:
        port = _make_port(_FixedLlm({}))
        current = finalize_intent(
            IntentInput(
                canonical="sales.quarterly_summary",
                params={"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
            )
        )
        out = asyncio.run(
            port.normalize(  # type: ignore[attr-defined]
                GuiAction(
                    kind="gui",
                    action="facet.change",
                    params={"intent": "sales.quarterly_summary", "groupBy": "channel"},
                    current=current,
                ),
                CTX,
            )
        )
        assert out.canonical == "sales.quarterly_summary"
        assert out.params == {"fiscalYear": 2026, "quarter": 3, "groupBy": "channel"}

    def test_drilldown_via_row_click(self) -> None:
        port = _make_port(_FixedLlm({}))
        current = finalize_intent(
            IntentInput(
                canonical="sales.quarterly_summary",
                params={"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
            )
        )
        out = asyncio.run(
            port.normalize(  # type: ignore[attr-defined]
                GuiAction(
                    kind="gui",
                    action="table1.rowClick",
                    params={"drilldown": "Japan"},
                    current=current,
                ),
                CTX,
            )
        )
        assert out.canonical == "sales.quarterly_summary"
        assert out.params == {
            "fiscalYear": 2026,
            "quarter": 3,
            "groupBy": "product",
            "region": "japan",
        }

    def test_unsupported_action_raises(self) -> None:
        port = _make_port(_FixedLlm({}))
        with pytest.raises(ValueError):
            asyncio.run(port.normalize(GuiAction(kind="gui", action="bogus", params={}), CTX))  # type: ignore[attr-defined]


class TestResolveAndShape:
    def test_resolve_query(self) -> None:
        port = _make_port(_FixedLlm({}))
        intent = finalize_intent(
            IntentInput(canonical="sales.trend", params={"metric": "revenue", "granularity": "month"})
        )
        handles = asyncio.run(port.resolve_query(intent))  # type: ignore[attr-defined]
        assert [h.uri for h in handles] == ["query://sales/trend?granularity=month&metric=revenue"]

    def test_data_version(self) -> None:
        repo = SalesRepo()
        cat = IntentCatalog()
        port = create_semantic_port(repo=repo, catalog_for=lambda _t: cat, llm=_FixedLlm({}))
        dv = asyncio.run(port.data_version(QueryHandle(uri="query://sales/summary?fy=2026")))
        assert dv == repo.data_version()

    def test_describe_shape(self) -> None:
        port = _make_port(_FixedLlm({}))
        shape = asyncio.run(
            port.describe_shape(QueryHandle(uri="query://sales/summary?fy=2026&groupBy=region&q=3"))  # type: ignore[attr-defined]
        )
        assert shape is not None
        assert [c.name for c in shape.columns] == ["region", "revenue", "units"]
        assert shape.rowCountHint == 4

    def test_describe_shape_unknown_path_raises(self) -> None:
        port = _make_port(_FixedLlm({}))
        with pytest.raises(ValueError):
            asyncio.run(port.describe_shape(QueryHandle(uri="query://sales/bogus")))  # type: ignore[attr-defined]
