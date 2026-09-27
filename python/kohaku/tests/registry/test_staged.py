"""Pytest port of packages/registry/test/staged.test.ts."""

from __future__ import annotations

from kohaku.registry import StagedCatalogOptions, core_catalog, resolve_catalog, staged_catalog_for

stable = resolve_catalog(core_catalog())
next_catalog = resolve_catalog(core_catalog())  # a distinct ResolvedCatalog instance stands in for "the migrated catalog"


def test_tenant_neutral_traffic_always_resolves_to_stable_even_if_in_rollout_would_admit_it() -> None:
    catalog_for = staged_catalog_for(StagedCatalogOptions(stable=stable, next=next_catalog, in_rollout=lambda _t: True))
    assert catalog_for(None) is stable


def test_a_tenant_admitted_by_in_rollout_gets_next() -> None:
    catalog_for = staged_catalog_for(
        StagedCatalogOptions(stable=stable, next=next_catalog, in_rollout=lambda tenant: tenant == "acme")
    )
    assert catalog_for("acme") is next_catalog


def test_a_tenant_not_admitted_by_in_rollout_gets_stable() -> None:
    catalog_for = staged_catalog_for(
        StagedCatalogOptions(stable=stable, next=next_catalog, in_rollout=lambda tenant: tenant == "acme")
    )
    assert catalog_for("globex") is stable


def test_in_rollout_is_never_called_for_tenant_neutral_traffic() -> None:
    called = False

    def in_rollout(_tenant: str) -> bool:
        nonlocal called
        called = True
        return True

    catalog_for = staged_catalog_for(StagedCatalogOptions(stable=stable, next=next_catalog, in_rollout=in_rollout))
    catalog_for(None)
    assert called is False
