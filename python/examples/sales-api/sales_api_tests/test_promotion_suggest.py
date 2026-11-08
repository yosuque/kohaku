"""Promotion schema suggestion E2E (port of apps/sample-api/test/promotion-suggest.e2e.test.ts).

The calendar heatmap is approvable without editing the prefill. The candidate is seeded straight into lineage
(component.generated + component.used) instead of being composed through the L2 path, then driven over REST
(evaluate -> approve) with a scripted FakeLlm that dispatches on the schema name, so the call order does not matter.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from kohaku.evals import (
    SchemaExtractionInput,
    SchemaExtractionResult,
    SchemaExtractor,
    create_schema_extractor,
)
from kohaku.llm import FakeLlm, GenerateObjectRequest
from kohaku.spec import PromotionState
from kohaku.storage import FileStoragePort
from sales_api.__main__ import schema_suggest_enabled, schema_suggest_timeout_ms
from sales_api.app import SalesApp, create_app
from sales_api.authz_port import create_hmac_authz_port

PREFIX = "/api/kohaku"
ARTIFACT_ID = "art-heatmap"

L2_HTML = (
    "<!DOCTYPE html><html><head><title>Sales calendar heatmap</title></head><body><div id=hm></div><script>"
    "window.kohaku.fetchData('query://sales/trend?fy=2026&granularity=month&metric=revenue')"
    ".then(function(d){document.getElementById('hm').textContent=d.rows.length+' months';"
    "window.kohaku.ready();});</script></body></html>"
)

SUGGESTION_OUTPUT: dict[str, Any] = {
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
    "events": [],
    "confidence": 0.9,
}

JUDGE_OUTPUT: dict[str, Any] = {
    "criteria": [
        {"id": "safety", "score": 0.9, "reasoning": "uses kohaku API only"},
        {"id": "determinism", "score": 0.8, "reasoning": "no randomness"},
        {"id": "a11y", "score": 0.7, "reasoning": "has text"},
        {"id": "schema_inferability", "score": 0.8, "reasoning": "parameterizable"},
        {"id": "generality", "score": 0.8, "reasoning": "general-purpose"},
        {"id": "visual_quality", "score": 0.8, "reasoning": "clean"},
        {"id": "suggestion_fidelity", "score": 0.9, "reasoning": "matches the fetched ref"},
    ],
    "summary": "worthy of promotion",
}


def _scripted_llm(*, extraction_raises: bool = False) -> FakeLlm:
    """Dispatches by schema name so the call order (extraction / judge) does not matter."""

    def script(req: GenerateObjectRequest) -> Any:
        if req.schema_name == "schema_suggestion":
            if extraction_raises:
                raise RuntimeError("extractor down")
            return SUGGESTION_OUTPUT
        if req.schema_name == "judge_verdict":
            return JUDGE_OUTPUT
        raise AssertionError(f"unexpected LLM call: {req.schema_name}")

    return FakeLlm(objects=script)


async def _build(
    tmp_path: Path,
    llm: FakeLlm,
    extractor: SchemaExtractor | None,
    storage: FileStoragePort | None = None,
) -> tuple[SalesApp, TestClient]:
    app = await create_app(
        llm=llm,
        storage=storage if storage is not None else FileStoragePort(tmp_path),
        authz=create_hmac_authz_port("test-secret"),
        schema_extractor=extractor,
    )
    return app, TestClient(app.app)


async def _seed_heatmap(app: SalesApp, *, tenant: str | None = None) -> None:
    await app.lineage.record(
        "component.generated",
        {"artifactId": ARTIFACT_ID, "html": L2_HTML, "request": "Sales as a calendar heatmap"},
        tenant=tenant,
    )
    for session in ("s1", "s2"):
        await app.lineage.record(
            "component.used",
            {"artifactId": ARTIFACT_ID, "surface": "chat", "sessionId": session, "outcome": "ok"},
            tenant=tenant,
        )


def _evaluate(client: TestClient, headers: dict[str, str] | None = None) -> dict[str, Any]:
    res = client.post(f"{PREFIX}/promotions/evaluate", headers=headers or {})
    assert res.status_code == 200
    candidates = res.json()["candidates"]
    assert len(candidates) == 1
    candidate: dict[str, Any] = candidates[0]
    return candidate


def test_evaluate_attaches_a_suggestion_and_approving_it_unchanged_records_a_zero_edit(
    tmp_path: Path,
) -> None:
    async def build() -> tuple[SalesApp, TestClient, FakeLlm]:
        llm = _scripted_llm()
        app, client = await _build(tmp_path, llm, create_schema_extractor(llm=llm))
        await _seed_heatmap(app)
        return app, client, llm

    _app, client, llm = asyncio.run(build())
    candidate = _evaluate(client)
    assert candidate["status"] == "candidate"
    assert candidate["suggestion"]["extractorId"] == "l2-schema-extraction"
    assert candidate["suggestion"]["draft"] == {
        **{k: v for k, v in SUGGESTION_OUTPUT.items() if k not in ("events", "confidence")},
        "version": "1.0.0",
    }
    # The extractor saw the fetched ref and the product's query paths.
    extraction = next(c for c in llm.calls if c.schema_name == "schema_suggestion")
    assert "query://sales/trend?fy=2026&granularity=month&metric=revenue" in extraction.prompt
    assert "## Supported query paths (queryTemplate.path candidates)\n" in extraction.prompt
    assert "trend" in extraction.prompt
    # The catalog summary carries the core Intent/component vocabulary even on the very first suggestion
    # (before anything has ever been promoted), so the "must be unique" instruction has something to check.
    assert "## Existing catalog (avoid these names)" in extraction.prompt
    assert "- sales.quarterly_summary (core intent)" in extraction.prompt
    assert "(core component)" in extraction.prompt

    # Approve with the suggested draft verbatim (what the UI sends when the reviewer edits nothing) and
    # acknowledge the suggestion (acceptedAsIs requires both an empty diff and acknowledgement).
    approve = client.post(
        f"{PREFIX}/promotions/{ARTIFACT_ID}/approve",
        json={"draft": candidate["suggestion"]["draft"], "acknowledgedSuggestion": True},
    )
    assert approve.status_code == 200
    assert approve.json()["candidate"]["status"] == "published"
    # The judge received both the schema being registered and the suggestion (context only) as evidence.
    judge_call = next(c for c in llm.calls if c.schema_name == "judge_verdict")
    assert "## Schema being registered (verify this against the HTML for schema fidelity)" in (
        judge_call.prompt
    )
    assert "## Proposed schema (machine-extracted; context only" in judge_call.prompt
    assert "sales.calendarHeatmap" in judge_call.prompt

    lineage = client.get(f"{PREFIX}/lineage", params={"artifactId": ARTIFACT_ID, "limit": 50})
    events = lineage.json()["events"]
    types = [e["type"] for e in events]
    assert types.index("component.schemaSuggested") > types.index("component.nominated")
    assert types.index("component.schemaEdited") > types.index("component.reviewed")
    edited = next(e for e in events if e["type"] == "component.schemaEdited")
    assert edited["actor"]["kind"] == "user"
    assert edited["payload"]["changed"] == []
    assert edited["payload"]["acknowledged"] is True

    summary = client.get(f"{PREFIX}/analytics/summary").json()["summary"]
    assert summary["promotions"]["schemaSuggested"] == 1
    assert summary["promotions"]["schemaEdited"] == 1
    assert summary["review"]["count"] == 1
    assert summary["review"]["acceptedAsIs"] == 1
    assert summary["review"]["durationMs"]["p50"] is not None


def test_fails_open_an_extraction_failure_reaches_the_hook_and_the_candidate_surfaces(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    async def build() -> TestClient:
        llm = _scripted_llm(extraction_raises=True)
        app, client = await _build(tmp_path, llm, create_schema_extractor(llm=llm))
        await _seed_heatmap(app)
        return client

    client = asyncio.run(build())
    with caplog.at_level(logging.ERROR):
        candidate = _evaluate(client)
    assert candidate["status"] == "candidate"
    assert "suggestion" not in candidate
    assert any("promotion.suggest.schema" in r.getMessage() for r in caplog.records)


def test_tells_the_extractor_which_tenant_it_is_extracting_for(tmp_path: Path) -> None:
    seen: list[str | None] = []

    class _Spy:
        def __init__(self, inner: SchemaExtractor) -> None:
            self._inner = inner

        async def extract(self, input: SchemaExtractionInput) -> SchemaExtractionResult:
            seen.append(input.tenant)
            return await self._inner.extract(input)

    async def build() -> TestClient:
        llm = _scripted_llm()
        app, client = await _build(tmp_path, llm, _Spy(create_schema_extractor(llm=llm)))
        await _seed_heatmap(app, tenant="acme")
        return client

    client = asyncio.run(build())
    _evaluate(client, {"x-kohaku-tenant": "acme"})
    assert seen == ["acme"]


def test_without_an_extractor_nothing_is_attached_and_no_extraction_call_is_made(
    tmp_path: Path,
) -> None:
    async def build() -> tuple[TestClient, FakeLlm]:
        llm = _scripted_llm()
        app, client = await _build(tmp_path, llm, None)
        await _seed_heatmap(app)
        return client, llm

    client, llm = asyncio.run(build())
    candidate = _evaluate(client)
    assert "suggestion" not in candidate
    assert not any(c.schema_name == "schema_suggestion" for c in llm.calls)


def test_a_malformed_persisted_suggestion_makes_the_judge_unable_to_run_not_schema_less(
    tmp_path: Path,
) -> None:
    """A persisted suggestion without a `draft` must not be forwarded as an empty draft (which would make the judge
    believe a schema was supplied): the sample's judge raises, and the verdict records "judge could not run"."""

    storage = FileStoragePort(tmp_path)

    async def build() -> tuple[TestClient, FakeLlm]:
        llm = _scripted_llm()
        app, client = await _build(tmp_path, llm, create_schema_extractor(llm=llm), storage)
        await _seed_heatmap(app)
        return client, llm

    client, llm = asyncio.run(build())
    candidate = _evaluate(client)
    state = asyncio.run(storage.get_promotion_state(ARTIFACT_ID, None))
    assert state is not None
    asyncio.run(
        storage.put_promotion_state(
            PromotionState(
                artifactId=state.artifactId,
                status=state.status,
                updatedAt=state.updatedAt,
                data={**state.data, "suggestion": {"extractorId": "x"}},
                tenant=state.tenant,
            )
        )
    )
    approve = client.post(
        f"{PREFIX}/promotions/{ARTIFACT_ID}/approve",
        json={"draft": candidate["suggestion"]["draft"]},
    )
    assert approve.status_code == 200  # the judge is advisory in the sample (judgeBlocking False)
    assert not any(c.schema_name == "judge_verdict" for c in llm.calls)
    events = client.get(
        f"{PREFIX}/lineage", params={"artifactId": ARTIFACT_ID, "limit": 50}
    ).json()["events"]
    judged = next(e for e in events if e["type"] == "component.judged")
    assert judged["payload"]["verdict"]["reason"].startswith("judge could not run")


def test_schema_suggest_env_switches(tmp_path: Path) -> None:
    assert schema_suggest_enabled({}) is True
    assert schema_suggest_enabled({"KOHAKU_PROMOTION_SCHEMA_SUGGEST": "1"}) is True
    assert schema_suggest_enabled({"KOHAKU_PROMOTION_SCHEMA_SUGGEST": "0"}) is False
    assert schema_suggest_timeout_ms({}) == 20_000
    assert schema_suggest_timeout_ms({"KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS": "1500"}) == 1500
    for bad in ("0", "-5", "abc", ""):
        assert (
            schema_suggest_timeout_ms({"KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS": bad}) == 20_000
        )
