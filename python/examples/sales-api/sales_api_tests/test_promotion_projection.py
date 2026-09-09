"""Promotion projection wiring test (corresponds to the promotion area of TS: apps/sample-api/src/app.ts).

Pins that publish (approve) -> the component (sandbox-template) and Intent (NL vocabulary) merge into the per-tenant
registry's catalog, and that after a restart (create_app's startup reconcile) they remain, re-projected from the
snapshot authority.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from kohaku.lineage import ComponentDraft, QueryTemplate
from kohaku.spec import Principal
from kohaku.storage import FileStoragePort
from sales_api.app import SalesApp, create_app
from sales_api.authz_port import create_hmac_authz_port
from sales_api.fake_llm import create_deterministic_fake_llm

_ARTIFACT_ID = "art-heatmap"
_COMPONENT_TYPE = "sales.heatmap"
_INTENT_NAME = "sales.heatmap_view"
_HTML = "<div id='root'>heatmap</div>"

_DRAFT = ComponentDraft(
    componentType=_COMPONENT_TYPE,
    version="1.0.0",
    intentName=_INTENT_NAME,
    description="Sales heatmap",
    queryTemplate=QueryTemplate(path="trend", paramMap={"fiscalYear": "fy"}),
)

_REVIEWER = Principal(id="rev-1", roles=["reviewer"])


async def _build(data_dir: Path) -> SalesApp:
    storage = FileStoragePort(data_dir)
    authz = create_hmac_authz_port("test-secret")
    llm = create_deterministic_fake_llm()
    return await create_app(llm=llm, storage=storage, authz=authz)


async def _seed_and_publish(app: SalesApp) -> None:
    # The material for the promotion candidate: append component.generated (including html), then transition all the way to published via approve.
    await app.lineage.record(
        "component.generated",
        {"artifactId": _ARTIFACT_ID, "html": _HTML, "request": "show sales as a heatmap"},
    )
    promotions = app.deps.promotions
    assert promotions is not None
    result = await promotions.approve(_ARTIFACT_ID, _DRAFT, _REVIEWER)
    assert result.status == "published"


def test_publish_projects_component_into_catalog(tmp_path: Path) -> None:
    async def run() -> None:
        app = await _build(tmp_path)
        await _seed_and_publish(app)
        # Projection: the promoted component merges into the per-tenant component catalog as a sandbox-template
        # (catalogFor is always fresh because publish invalidates the registry's memoization).
        catalog_for = app.compose_ctx.catalogFor
        assert catalog_for is not None
        comp = catalog_for(None).get(_COMPONENT_TYPE)
        assert comp is not None
        assert comp.implementation.kind == "sandbox-template"
        assert comp.implementation.html == _HTML
        # The merge into the Intent vocabulary is pinned by the restart test (app.intent_catalog after reconcile).

    asyncio.run(run())


def test_reconcile_restores_projection_after_restart(tmp_path: Path) -> None:
    async def run() -> None:
        # First time: publish (stamps published into the snapshot authority promotions.json).
        app1 = await _build(tmp_path)
        await _seed_and_publish(app1)

        # Second time: create_app with the same .data (startup reconcile rebuilds the projection from the snapshot).
        app2 = await _build(tmp_path)
        # The promoted Intent is re-projected (app2.intent_catalog is the base built after reconcile).
        assert _INTENT_NAME in app2.intent_catalog.names()
        # The promoted component is re-projected.
        catalog_for2 = app2.compose_ctx.catalogFor
        assert catalog_for2 is not None
        assert catalog_for2(None).get(_COMPONENT_TYPE) is not None

    asyncio.run(run())
