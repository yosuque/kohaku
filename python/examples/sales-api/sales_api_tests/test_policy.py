"""E2E for Policy as Code (design.md #69/#70). Port of
apps/sample-api/test/policy.e2e.test.ts.

- tenant-a (allowL2=false) never reaches L2, even for an intent whose route_tier forces a direct L2 entry.
- tenant-b (dailyTokens=0) always falls back on the very first compose call (the budget check runs
  pre-flight, before any LLM call).
- Reloading the policy changes the compose fingerprint (a cache hit before reload becomes a miss after).
All 3 exercise the actual shipped python/examples/sales-api/policy/kohaku.policy.json.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from kohaku.host_core import load_policy_file
from kohaku.spec import KohakuPolicyFile, LineageFilter, PolicyCompose, PolicySection
from kohaku.storage import MemoryStoragePort
from sales_api.app import SalesApp, create_app
from sales_api.authz_port import create_hmac_authz_port
from sales_api.fake_llm import create_deterministic_fake_llm

POLICY_FILE_PATH = Path(__file__).resolve().parent.parent / "policy" / "kohaku.policy.json"


def _load_policy() -> KohakuPolicyFile:
    return asyncio.run(load_policy_file(POLICY_FILE_PATH)).file


def _build(policy_file: KohakuPolicyFile) -> tuple[TestClient, SalesApp]:
    app = asyncio.run(
        create_app(
            llm=create_deterministic_fake_llm(),
            storage=MemoryStoragePort(),
            authz=create_hmac_authz_port("test-secret"),
            policy_file=policy_file,
        )
    )
    return TestClient(app.app), app


def _custom_body() -> dict[str, Any]:
    """A free-form request: sales-api's shared route_tier forces sales.custom straight to L2 (no L1
    attempt), so this is the only intent that exercises both the allowL2 gate and the L2 budget check
    without any grammar-constrained L1 step in between. Sent as a direct {intent} (not NL text), so the
    semantic port's normalize is never called either -- fully LLM-free regardless of outcome."""
    return {"intent": {"canonical": "sales.custom", "params": {"request": "Sales as a calendar heatmap"}}}


def _kpi_overview_body() -> dict[str, Any]:
    return {"intent": {"canonical": "sales.kpi_overview", "params": {"fiscalYear": 2026}}}


class TestPolicyAsCodeE2E:
    def test_tenant_a_allow_l2_false_never_reaches_l2(self) -> None:
        client, _app = _build(_load_policy())
        res = client.post(
            "/api/kohaku/compose", json=_custom_body(), headers={"x-kohaku-tenant": "tenant-a"}
        )
        assert res.status_code == 200
        spec = res.json()["spec"]
        assert "disabled in this environment" in spec["provenance"]["fallback"]["reason"]

    def test_tenant_b_daily_tokens_zero_always_falls_back_on_the_first_call(self) -> None:
        client, _app = _build(_load_policy())
        res = client.post(
            "/api/kohaku/compose", json=_custom_body(), headers={"x-kohaku-tenant": "tenant-b"}
        )
        assert res.status_code == 200
        spec = res.json()["spec"]
        assert "Budget exceeded" in spec["provenance"]["fallback"]["reason"]

    def test_a_tenant_the_policy_file_does_not_mention_is_unaffected(self) -> None:
        client, _app = _build(_load_policy())
        res = client.post(
            "/api/kohaku/compose", json=_kpi_overview_body(), headers={"x-kohaku-tenant": "tenant-c"}
        )
        assert res.status_code == 200
        spec = res.json()["spec"]
        assert spec["provenance"].get("fallback") is None
        assert spec["provenance"]["tier"] == "L0"

    def test_reloading_the_policy_changes_the_compose_fingerprint(self) -> None:
        file = _load_policy()
        client, app = _build(file)
        assert app.policy_runtime is not None

        def compose() -> dict[str, Any]:
            res = client.post(
                "/api/kohaku/compose", json=_kpi_overview_body(), headers={"x-kohaku-tenant": "tenant-a"}
            )
            assert res.status_code == 200
            spec: dict[str, Any] = res.json()["spec"]
            return spec

        assert compose()["provenance"]["cache"] == "miss"
        assert compose()["provenance"]["cache"] == "hit"

        # Flip tenant-a's allowL2 from false to true (tierGate's fingerprint material changes:
        # {allowL2: false, ...} -> {allowL2: true, ...}), keeping every other field the same.
        flipped = file.model_copy(
            update={
                "tenants": {
                    **(file.tenants or {}),
                    "tenant-a": PolicySection(compose=PolicyCompose(allowL2=True)),
                }
            }
        )
        asyncio.run(app.policy_runtime.reload(flipped, "test"))

        assert compose()["provenance"]["cache"] == "miss"
        assert compose()["provenance"]["cache"] == "hit"

    def test_records_a_policy_applied_lineage_event_on_reload_tenant_neutral(self) -> None:
        file = _load_policy()
        _client, app = _build(file)
        assert app.policy_runtime is not None
        flipped = file.model_copy(
            update={
                "tenants": {
                    **(file.tenants or {}),
                    "tenant-a": PolicySection(compose=PolicyCompose(allowL2=True)),
                }
            }
        )
        asyncio.run(app.policy_runtime.reload(flipped, "test-operator"))

        events = asyncio.run(app.lineage.list_events(LineageFilter(type=["policy.applied"])))
        assert len(events) == 1
        assert "tenants.tenant-a.compose.allowL2" in events[0].payload["changedPaths"]
        assert events[0].tenant is None
        assert events[0].actor.kind == "system"
        assert events[0].actor.id == "test-operator"
