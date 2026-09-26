"""End-to-end check of the direct-Intent validation gap (t0-3a/t0-3b): kind: "intent" bypassed
SemanticPort.normalize (and any Intent-catalog lookup it consults internally), so an invalid params value
like metric:"bogus" used to reach finalize_intent unchecked, mint a fresh intentHash, and eventually fail
inside compose with a 500 (query resolution). sales-api's SalesSemanticPort now implements validate_intent
(backed by IntentCatalog.validate_params), so every entry point that resolves a directly-specified Intent
(host_core's resolve_intent) should reject it with 422 INTENT_INVALID instead, before anything is composed,
cached, recorded to lineage, or fixated. Port of apps/sample-api/test/intent-validation.e2e.test.ts.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from kohaku.spec import IntentInput, LineageFilter, compute_intent_hash
from kohaku.storage import FileStoragePort
from sales_api.app import SalesApp, create_app
from sales_api.authz_port import create_hmac_authz_port
from sales_api.fake_llm import create_deterministic_fake_llm

# A real Intent from sales-api's catalog whose `metric` param is a closed enum (revenue/units).
INVALID_INTENT: dict[str, Any] = {"canonical": "sales.trend", "params": {"metric": "bogus"}}


def _build(tmp_path: Path) -> tuple[TestClient, SalesApp]:
    app = asyncio.run(
        create_app(
            llm=create_deterministic_fake_llm(),
            storage=FileStoragePort(tmp_path),
            authz=create_hmac_authz_port("test-secret"),
        )
    )
    return TestClient(app.app), app


def _composed_count(app: SalesApp) -> int:
    events = asyncio.run(app.lineage.list_events(LineageFilter(type=["view.composed"])))
    return len(events)


def _interacted_count(app: SalesApp) -> int:
    events = asyncio.run(app.lineage.list_events(LineageFilter(type=["view.interacted"])))
    return len(events)


class TestDirectIntentValidationAcrossComposeEventsFixationsApprove:
    def test_compose_with_an_invalid_params_value_is_422_and_records_no_view_composed(
        self, tmp_path: Path
    ) -> None:
        client, app = _build(tmp_path)
        assert _composed_count(app) == 0

        res = client.post("/api/kohaku/compose", json={"intent": INVALID_INTENT})

        assert res.status_code == 422
        body = res.json()
        assert body["error"]["code"] == "INTENT_INVALID"
        assert "metric" in body["error"]["message"]
        assert _composed_count(app) == 0

    def test_events_with_the_invalid_intent_as_current_is_422_and_records_nothing(
        self, tmp_path: Path
    ) -> None:
        client, app = _build(tmp_path)

        res = client.post(
            "/api/kohaku/events",
            json={"intent": INVALID_INTENT, "event": {"on": "table1.sort", "payload": {}}},
        )

        assert res.status_code == 422
        assert res.json()["error"]["code"] == "INTENT_INVALID"
        assert _composed_count(app) == 0
        assert _interacted_count(app) == 0

    def test_fixations_approve_with_the_invalid_intent_is_422_and_no_fixation_is_written(
        self, tmp_path: Path
    ) -> None:
        client, app = _build(tmp_path)
        assert asyncio.run(app.fixations.list_fixations()) == []

        res = client.post("/api/kohaku/fixations/approve", json={"intent": INVALID_INTENT})

        assert res.status_code == 422
        assert res.json()["error"]["code"] == "INTENT_INVALID"
        assert asyncio.run(app.fixations.list_fixations()) == []
        # Rejected before compose ever runs, so nothing was composed/cached either.
        assert _composed_count(app) == 0

    def test_valid_params_still_compose_normally_and_the_hash_is_unaffected_by_validation(
        self, tmp_path: Path
    ) -> None:
        client, _app = _build(tmp_path)

        res = client.post(
            "/api/kohaku/compose",
            json={
                "intent": {
                    "canonical": "sales.trend",
                    "params": {"metric": "revenue", "granularity": "month"},
                }
            },
        )

        assert res.status_code == 200
        body = res.json()
        # Hash compatibility: params that fully specify every schema default hash exactly like the plain,
        # unvalidated Intent always would have (validation does not perturb an already-normalized request).
        expected_hash = compute_intent_hash(
            IntentInput(canonical="sales.trend", params={"metric": "revenue", "granularity": "month"})
        )
        assert body["spec"]["intent"]["hash"] == expected_hash

    def test_params_relying_on_a_schema_default_now_get_it_filled_in_changing_the_hash_by_design(
        self, tmp_path: Path
    ) -> None:
        client, _app = _build(tmp_path)

        res = client.post(
            "/api/kohaku/compose", json={"intent": {"canonical": "sales.trend", "params": {}}}
        )

        assert res.status_code == 200
        body = res.json()
        # Before this fix, kind: "intent" hashed params exactly as given (no defaulting), so an empty params
        # object would hash differently from the explicit-defaults form below -- and differently from what
        # this endpoint now actually returns, since validate_intent fills the schema defaults in.
        hash_of_empty_params = compute_intent_hash(IntentInput(canonical="sales.trend", params={}))
        hash_of_explicit_defaults = compute_intent_hash(
            IntentInput(canonical="sales.trend", params={"metric": "revenue", "granularity": "month"})
        )
        assert hash_of_empty_params != hash_of_explicit_defaults
        assert body["spec"]["intent"]["hash"] == hash_of_explicit_defaults
        assert body["spec"]["intent"]["hash"] != hash_of_empty_params
