"""Tests for the REST sample's demo endpoints (corresponds to TS: apps/sample-api/src/app.ts's /api/health,
/api/admin/bump-data-version).
"""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from kohaku.storage import MemoryStoragePort
from sales_api.app import create_app
from sales_api.authz_port import create_hmac_authz_port
from sales_api.fake_llm import create_deterministic_fake_llm


def _client() -> TestClient:
    storage = MemoryStoragePort()
    authz = create_hmac_authz_port("test-secret")
    llm = create_deterministic_fake_llm()
    app = asyncio.run(create_app(llm=llm, storage=storage, authz=authz))
    return TestClient(app.app)


class TestHealth:
    def test_health_reports_seed_llm_and_catalog(self) -> None:
        client = _client()
        res = client.get("/api/health")
        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert body["llm"]["provider"] == "fake"
        assert body["seed"]["records"] > 0
        assert isinstance(body["catalogVersion"], str) and body["catalogVersion"] != ""
        # All core Intents appear (no promotions before promotion).
        assert "sales.quarterly_summary" in body["intents"]
        assert body["promoted"] == []


class TestBumpDataVersion:
    def test_bump_advances_data_version(self) -> None:
        client = _client()
        before = client.get("/api/health").json()["seed"]["dataVersion"]
        bumped = client.post("/api/admin/bump-data-version").json()["dataVersion"]
        assert bumped != before
        # health reflects the new data version.
        after = client.get("/api/health").json()["seed"]["dataVersion"]
        assert after == bumped
