"""Pytest port of packages/host-core/test/catalog-impact.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
from typing import Any

from kohaku.host_core import CatalogImpactReport, analyze_catalog_impact
from kohaku.registry import (
    CapabilityDecl,
    Catalog,
    ComponentDefinition,
    DeprecationDecl,
    DeprecationReplacedBy,
    PropsSchema,
    ResolvedCatalog,
    core_catalog,
    define_component,
    resolve_catalog,
)
from kohaku.spec import (
    ComponentNode,
    FixationRecord,
    Intent,
    Principal,
    PromotionState,
    Provenance,
    UISpec,
)

INTENT_HASH = "sha256:" + "1" * 64
DEPRECATED_TYPE = "sales.kpiCardOld"
REPLACEMENT_TYPE = "sales.kpiCardNew"


def _fixed_spec(components: list[dict[str, Any]]) -> UISpec:
    return UISpec(
        kohaku="0.1",
        intent=Intent(canonical="sales.trend", params={}, hash=INTENT_HASH),
        dataVersion="v1",
        components=[ComponentNode(**c) for c in components],
        events=[],
        provenance=Provenance(tier="L0", composedBy="fixture", cache="fixated"),
    )


def _fixation(pinned_spec: UISpec) -> FixationRecord:
    return FixationRecord(
        intentHash=INTENT_HASH,
        canonical="sales.trend",
        structureHash="irrelevant-for-this-test",
        pinnedSpec=pinned_spec,
        fixatedAt="2026-01-01T00:00:00Z",
        approver=Principal(id="admin"),
    )


def _promotion(artifact_id: str, status: str = "in_use", data: dict[str, Any] | None = None) -> PromotionState:
    return PromotionState(artifactId=artifact_id, status=status, updatedAt="2026-01-01T00:00:00Z", data=data or {})


def _replacement_def() -> ComponentDefinition:
    return define_component(
        ComponentDefinition(
            type=REPLACEMENT_TYPE,
            version="1.0.0",
            description="replacement",
            propsSchema=PropsSchema({"type": "object", "properties": {"label": {"type": "string"}}}),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
        )
    )


def _deprecated_decl() -> DeprecationDecl:
    return DeprecationDecl(
        reason="superseded by sales.kpiCardNew",
        since="2026-01-01",
        sunset="2026-12-31",
        replacedBy=DeprecationReplacedBy(type=REPLACEMENT_TYPE),
    )


def _deprecated_def() -> ComponentDefinition:
    return define_component(
        ComponentDefinition(
            type=DEPRECATED_TYPE,
            version="1.0.0",
            description="old kpi card",
            propsSchema=PropsSchema({"type": "object", "properties": {"label": {"type": "string"}}}),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
            deprecated=_deprecated_decl(),
        )
    )


def _deprecated_catalog() -> ResolvedCatalog:
    return resolve_catalog(core_catalog(), Catalog(components=[_replacement_def(), _deprecated_def()]))


class _StubStorage:
    """Storage stub keyed by tenant ("" = tenant-neutral / None), mirroring the TS test's stubStorage."""

    def __init__(self, by_tenant: dict[str, dict[str, list[Any]]]) -> None:
        self._by_tenant = by_tenant

    @staticmethod
    def _key(tenant: str | None) -> str:
        return tenant or ""

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]:
        return self._by_tenant.get(self._key(tenant), {}).get("fixations", [])

    async def list_promotion_states(self, tenant: str | None = None) -> list[PromotionState]:
        return self._by_tenant.get(self._key(tenant), {}).get("promotions", [])

    # Unused by analyze_catalog_impact but present so this stub structurally resembles a real StoragePort.
    async def get_spec_cache(self, key: str) -> Any:
        return None

    async def put_spec_cache(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def append_lineage(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def list_lineage(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []

    async def get_promotion_state(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def put_promotion_state(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def get_fixation(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def put_fixation(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def delete_fixation(self, *args: Any, **kwargs: Any) -> None:
        raise NotImplementedError


def test_returns_every_list_empty_when_nothing_is_wrong() -> None:
    catalog = resolve_catalog(core_catalog())
    storage = _StubStorage(
        {
            "": {
                "fixations": [_fixation(_fixed_spec([{"id": "root", "type": "layout.stack", "props": {}}]))],
                "promotions": [_promotion("a1", status="published", data={"componentType": "layout.stack"})],
            }
        }
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(storage=storage, catalog_for=lambda _t: catalog)

    report = asyncio.run(run())
    assert report == CatalogImpactReport()


def test_fixation_issues_for_a_pinned_spec_referencing_an_unknown_type() -> None:
    catalog = resolve_catalog(core_catalog())
    storage = _StubStorage(
        {"": {"fixations": [_fixation(_fixed_spec([{"id": "root", "type": "no.such.type", "props": {}}]))]}}
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(storage=storage, catalog_for=lambda _t: catalog)

    report = asyncio.run(run())
    assert len(report.fixationIssues) == 1
    assert report.fixationIssues[0].intentHash == INTENT_HASH
    assert "root:" in report.fixationIssues[0].issues[0]
    assert "no.such.type" in report.fixationIssues[0].issues[0]


def test_deprecated_usage_aggregates_fixations_and_promotions_of_any_status() -> None:
    catalog = _deprecated_catalog()
    storage = _StubStorage(
        {
            "": {
                "fixations": [
                    _fixation(
                        _fixed_spec(
                            [
                                {"id": "root", "type": "layout.stack", "props": {}, "children": ["k"]},
                                {
                                    "id": "k",
                                    "type": DEPRECATED_TYPE,
                                    "props": {"label": "Revenue"},
                                    "data": {"$ref": "query://sales/x"},
                                },
                            ]
                        )
                    )
                ],
                "promotions": [
                    _promotion(
                        "candidate-1",
                        status="candidate",
                        data={"draft": {"componentType": DEPRECATED_TYPE, "version": "1.0.0"}},
                    )
                ],
            }
        }
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(storage=storage, catalog_for=lambda _t: catalog)

    report = asyncio.run(run())
    assert len(report.deprecatedUsage) == 1
    entry = report.deprecatedUsage[0]
    assert entry.type == DEPRECATED_TYPE
    assert entry.deprecated.reason == "superseded by sales.kpiCardNew"
    assert entry.deprecated.sunset == "2026-12-31"
    assert [dataclasses.asdict(f) for f in entry.fixations] == [{"intentHash": INTENT_HASH, "tenant": None}]
    assert [dataclasses.asdict(p) for p in entry.promotions] == [
        {"artifactId": "candidate-1", "tenant": None, "status": "candidate"}
    ]
    # A not-yet-published candidate on a deprecated type is not itself a "published promotion issue".
    assert report.publishedPromotionIssues == []


def test_published_promotion_issues_reason_deprecated() -> None:
    catalog = _deprecated_catalog()
    storage = _StubStorage(
        {"": {"promotions": [_promotion("pub-1", status="published", data={"componentType": DEPRECATED_TYPE})]}}
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(storage=storage, catalog_for=lambda _t: catalog)

    report = asyncio.run(run())
    assert len(report.publishedPromotionIssues) == 1
    issue = report.publishedPromotionIssues[0]
    assert issue.artifactId == "pub-1"
    assert issue.componentType == DEPRECATED_TYPE
    assert issue.reason == "deprecated"
    assert issue.deprecated == _deprecated_decl()


def test_published_promotion_issues_reason_removed() -> None:
    catalog = resolve_catalog(core_catalog())  # "vanished.type" never existed here
    storage = _StubStorage(
        {"": {"promotions": [_promotion("pub-2", status="published", data={"componentType": "vanished.type"})]}}
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(storage=storage, catalog_for=lambda _t: catalog)

    report = asyncio.run(run())
    assert report.publishedPromotionIssues == [
        dataclasses.replace(
            report.publishedPromotionIssues[0], artifactId="pub-2", componentType="vanished.type", reason="removed"
        )
    ]


def test_origin_kit_mismatches_flags_a_published_candidate_generated_under_a_different_kit() -> None:
    catalog = resolve_catalog(core_catalog())
    storage = _StubStorage(
        {
            "": {
                "promotions": [
                    _promotion(
                        "pub-3",
                        status="published",
                        data={"componentType": "layout.stack", "origin": {"kit": {"id": "default", "version": "1.0.0"}}},
                    ),
                    _promotion(
                        "pub-4",
                        status="published",
                        data={"componentType": "layout.stack", "origin": {"kit": {"id": "default", "version": "2.0.0"}}},
                    ),
                ]
            }
        }
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(
            storage=storage, catalog_for=lambda _t: catalog, current_kit={"id": "default", "version": "2.0.0"}
        )

    report = asyncio.run(run())
    assert len(report.originKitMismatches) == 1
    mismatch = report.originKitMismatches[0]
    assert mismatch.artifactId == "pub-3"
    assert mismatch.kit == {"id": "default", "version": "1.0.0"}
    assert mismatch.currentKit == {"id": "default", "version": "2.0.0"}


def test_skips_origin_kit_check_entirely_when_current_kit_is_omitted() -> None:
    catalog = resolve_catalog(core_catalog())
    storage = _StubStorage(
        {
            "": {
                "promotions": [
                    _promotion(
                        "pub-5",
                        status="published",
                        data={"componentType": "layout.stack", "origin": {"kit": {"id": "default", "version": "1.0.0"}}},
                    )
                ]
            }
        }
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(storage=storage, catalog_for=lambda _t: catalog)

    report = asyncio.run(run())
    assert report.originKitMismatches == []


def test_sweeps_every_tenant_tagging_each_finding_with_its_own_tenant() -> None:
    catalog = _deprecated_catalog()
    storage = _StubStorage(
        {
            "": {
                "fixations": [
                    _fixation(
                        _fixed_spec(
                            [{"id": "k", "type": DEPRECATED_TYPE, "props": {"label": "x"}, "data": {"$ref": "query://sales/x"}}]
                        )
                    )
                ]
            },
            "acme": {
                "promotions": [_promotion("acme-1", status="published", data={"componentType": DEPRECATED_TYPE})]
            },
        }
    )

    async def run() -> CatalogImpactReport:
        return await analyze_catalog_impact(storage=storage, catalog_for=lambda _t: catalog, tenants=[None, "acme"])

    report = asyncio.run(run())
    assert len(report.deprecatedUsage) == 1
    entry = report.deprecatedUsage[0]
    assert [dataclasses.asdict(f) for f in entry.fixations] == [{"intentHash": INTENT_HASH, "tenant": None}]
    assert [dataclasses.asdict(p) for p in entry.promotions] == [
        {"artifactId": "acme-1", "tenant": "acme", "status": "published"}
    ]
    assert len(report.publishedPromotionIssues) == 1
    issue = report.publishedPromotionIssues[0]
    assert issue.artifactId == "acme-1"
    assert issue.tenant == "acme"
    assert issue.componentType == DEPRECATED_TYPE
    assert issue.reason == "deprecated"
