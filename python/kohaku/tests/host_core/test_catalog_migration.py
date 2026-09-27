"""Pytest port of packages/host-core/test/catalog-migration.test.ts."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any

from kohaku.host_core import (
    CatalogMigrationApplyResult,
    CatalogMigrationFixationReplacer,
    CatalogMigrationPlan,
    apply_catalog_migration,
    plan_catalog_migration,
    verify_catalog_migration_plan,
)
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
from kohaku.spec import ComponentNode, FixationRecord, Intent, Principal, Provenance, UISpec

INTENT_HASH_CLEAN = "sha256:" + "1" * 64
INTENT_HASH_BLOCKED = "sha256:" + "2" * 64
INTENT_HASH_UNTOUCHED = "sha256:" + "3" * 64

OLD_CLEAN_TYPE = "sales.kpiCardOld"
OLD_BAD_TYPE = "sales.badOld"
NEW_TYPE = "sales.kpiCardNew"


def _fixed_spec(intent_hash: str, components: list[dict[str, Any]]) -> UISpec:
    return UISpec(
        kohaku="0.1",
        intent=Intent(canonical="sales.trend", params={}, hash=intent_hash),
        dataVersion="v1",
        components=[ComponentNode(**c) for c in components],
        events=[],
        provenance=Provenance(tier="L0", composedBy="fixture", cache="fixated"),
    )


def _fixation(
    intent_hash: str,
    pinned_spec: UISpec,
    *,
    structureHash: str = "before-hash",
    revision: str | None = None,
    tenant: str | None = None,
    catalogFingerprint: str | None = None,
) -> FixationRecord:
    return FixationRecord(
        intentHash=intent_hash,
        canonical="sales.trend",
        structureHash=structureHash,
        pinnedSpec=pinned_spec,
        fixatedAt="2026-01-01T00:00:00Z",
        approver=Principal(id="admin"),
        revision=revision,
        tenant=tenant,
        catalogFingerprint=catalogFingerprint,
    )


class _StubStorage:
    def __init__(self, fixations: dict[str | None, list[FixationRecord]]) -> None:
        self._fixations = fixations

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]:
        return self._fixations.get(tenant, [])

    async def list_promotion_states(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []

    async def get_spec_cache(self, *args: Any, **kwargs: Any) -> None:
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


def _new_type_def() -> ComponentDefinition:
    return define_component(
        ComponentDefinition(
            type=NEW_TYPE,
            version="1.0.0",
            description="new kpi card",
            propsSchema=PropsSchema(
                {
                    "type": "object",
                    "properties": {"label": {"type": "string"}, "format": {"enum": ["currency", "percent"]}},
                    "required": ["label", "format"],
                }
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
        )
    )


def _old_clean_type_def() -> ComponentDefinition:
    return define_component(
        ComponentDefinition(
            type=OLD_CLEAN_TYPE,
            version="1.0.0",
            description="old kpi card (migrates cleanly, modulo missing migrateProps -- see below)",
            propsSchema=PropsSchema(
                {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
            deprecated=DeprecationDecl(reason="superseded", replacedBy=DeprecationReplacedBy(type=NEW_TYPE)),
        )
    )


def _old_bad_type_def() -> ComponentDefinition:
    return define_component(
        ComponentDefinition(
            type=OLD_BAD_TYPE,
            version="1.0.0",
            description="old kpi card (also ends up missing NEW_TYPE's required format)",
            propsSchema=PropsSchema(
                {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
            deprecated=DeprecationDecl(reason="superseded", replacedBy=DeprecationReplacedBy(type=NEW_TYPE)),
        )
    )


def _migration_catalog() -> ResolvedCatalog:
    return resolve_catalog(
        core_catalog(), Catalog(components=[_new_type_def(), _old_clean_type_def(), _old_bad_type_def()])
    )


def _clean_fixation() -> FixationRecord:
    return _fixation(
        INTENT_HASH_CLEAN,
        _fixed_spec(
            INTENT_HASH_CLEAN,
            [{"id": "kpi1", "type": OLD_CLEAN_TYPE, "props": {"label": "Revenue"}, "data": {"$ref": "query://sales/revenue"}}],
        ),
        structureHash="clean-before",
        revision="rev-clean",
        catalogFingerprint="fp-clean-before",
    )


def _blocked_fixation() -> FixationRecord:
    return _fixation(
        INTENT_HASH_BLOCKED,
        _fixed_spec(
            INTENT_HASH_BLOCKED,
            [{"id": "kpi2", "type": OLD_BAD_TYPE, "props": {"label": "Cost"}, "data": {"$ref": "query://sales/cost"}}],
        ),
        structureHash="blocked-before",
    )


def _untouched_fixation() -> FixationRecord:
    return _fixation(
        INTENT_HASH_UNTOUCHED,
        _fixed_spec(INTENT_HASH_UNTOUCHED, [{"id": "root", "type": "layout.stack", "props": {}}]),
    )


# --- plan_catalog_migration ---


def test_a_props_incompatible_rewrite_is_blocked_rather_than_silently_dropped() -> None:
    # Python's ComponentDefinition has no migrateProps (TS-only -- see kohaku.registry.types.DeprecationDecl's
    # doc), so under `_migration_catalog()` (NEW_TYPE requires `format`, which nothing here ever supplies)
    # even OLD_CLEAN_TYPE's rewrite fails revalidation. This is exactly the scenario `blocked` exists for;
    # `test_rewrites_type_and_version_even_without_migrate_props` below covers the successful-rewrite path
    # with a NEW_TYPE that doesn't require anything migrateProps would have supplied.
    catalog = _migration_catalog()
    storage = _StubStorage({None: [_clean_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    assert plan.steps == []
    assert len(plan.blocked) == 1
    assert plan.blocked[0].intentHash == INTENT_HASH_CLEAN
    assert plan.blocked[0].types == [OLD_CLEAN_TYPE]


def test_rewrites_type_and_version_even_without_migrate_props() -> None:
    # A variant of the above using a NEW_TYPE whose schema does NOT require anything beyond `label`, so the
    # type/version rewrite alone (no props change) is enough to pass revalidation -- proving the rewrite
    # itself (not just the revalidation gate) works correctly in the absence of migrateProps.
    new_type_no_extra_fields = define_component(
        ComponentDefinition(
            type=NEW_TYPE,
            version="2.0.0",
            description="new kpi card (label only)",
            propsSchema=PropsSchema(
                {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
        )
    )
    old = _old_clean_type_def()
    catalog = resolve_catalog(core_catalog(), Catalog(components=[new_type_no_extra_fields, old]))
    storage = _StubStorage({None: [_clean_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    assert plan.blocked == []
    assert len(plan.steps) == 1
    step = plan.steps[0]
    assert step.intentHash == INTENT_HASH_CLEAN
    assert step.rewrittenNodeIds == ["kpi1"]
    assert step.beforeStructureHash == "clean-before"
    assert step.beforeRevision == "rev-clean"
    rewritten = next(c for c in step.pinnedSpec.components if c.id == "kpi1")
    assert rewritten.type == NEW_TYPE
    # replacedBy did not pin a version, so the old version pin is cleared rather than carried over.
    assert rewritten.version is None
    assert rewritten.props == {"label": "Revenue"}
    assert step.afterStructureHash != step.beforeStructureHash


def test_skips_a_fixation_referencing_no_deprecated_type_entirely() -> None:
    catalog = _migration_catalog()
    storage = _StubStorage({None: [_untouched_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    assert plan.steps == []
    assert plan.blocked == []


def test_rewrites_lists_every_deprecated_with_replacement_type_even_with_no_matching_fixations() -> None:
    catalog = _migration_catalog()
    storage = _StubStorage({None: []})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    froms = sorted(r.from_ for r in plan.rewrites)
    assert froms == [OLD_BAD_TYPE, OLD_CLEAN_TYPE]
    assert all(r.to == {"type": NEW_TYPE} for r in plan.rewrites)


def test_types_option_narrows_planning() -> None:
    catalog = _migration_catalog()
    storage = _StubStorage({None: [_clean_fixation(), _blocked_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(
            storage=storage, catalog_for=lambda _t: catalog, types=[OLD_CLEAN_TYPE]
        )

    plan = asyncio.run(run())
    assert [r.from_ for r in plan.rewrites] == [OLD_CLEAN_TYPE]
    # OLD_BAD_TYPE was never in scope, so its fixation isn't even attempted (not in blocked either).
    assert all(b.intentHash != INTENT_HASH_BLOCKED for b in plan.blocked)


def test_plan_hash_is_deterministic_and_reacts_to_content_changes() -> None:
    catalog = _migration_catalog()

    async def run(fixations: list[FixationRecord]) -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=_StubStorage({None: fixations}), catalog_for=lambda _t: catalog)

    a = asyncio.run(run([_clean_fixation()]))
    b = asyncio.run(run([_clean_fixation()]))
    assert a.planHash == b.planHash
    assert a.planHash.startswith("sha256:")

    c = asyncio.run(run([_clean_fixation(), _blocked_fixation()]))
    assert c.planHash != a.planHash


def test_plan_hash_changes_when_only_the_catalogs_fingerprint_differs() -> None:
    async def run(catalog: ResolvedCatalog) -> CatalogMigrationPlan:
        return await plan_catalog_migration(
            storage=_StubStorage({None: [_clean_fixation()]}), catalog_for=lambda _t: catalog
        )

    a = asyncio.run(run(_no_extra_fields_catalog()))
    b = asyncio.run(run(_no_extra_fields_catalog_with_extra_component()))
    assert a.steps[0].rewrittenNodeIds == b.steps[0].rewrittenNodeIds
    assert a.steps[0].targetCatalogFingerprint != b.steps[0].targetCatalogFingerprint
    assert a.planHash != b.planHash


def test_records_target_and_before_catalog_fingerprint_on_each_step() -> None:
    catalog = _no_extra_fields_catalog()
    storage = _StubStorage({None: [_clean_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    step = plan.steps[0]
    assert step.targetCatalogFingerprint == catalog.fingerprint
    assert step.beforeCatalogFingerprint == "fp-clean-before"


def test_omits_before_catalog_fingerprint_for_a_legacy_fixation() -> None:
    catalog = _no_extra_fields_catalog()
    legacy = _fixation(
        INTENT_HASH_CLEAN,
        _fixed_spec(
            INTENT_HASH_CLEAN,
            [{"id": "kpi1", "type": OLD_CLEAN_TYPE, "props": {"label": "Revenue"}, "data": {"$ref": "query://sales/revenue"}}],
        ),
    )
    storage = _StubStorage({None: [legacy]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    assert plan.steps[0].beforeCatalogFingerprint is None


def test_sweeps_every_tenant_tagging_steps_and_blocked() -> None:
    new_type_no_extra_fields = define_component(
        ComponentDefinition(
            type=NEW_TYPE,
            version="2.0.0",
            description="new kpi card (label only)",
            propsSchema=PropsSchema(
                {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
        )
    )
    catalog = resolve_catalog(core_catalog(), Catalog(components=[new_type_no_extra_fields, _old_clean_type_def()]))
    acme_fixation = replace(_clean_fixation(), tenant="acme")
    storage = _StubStorage({"acme": [acme_fixation]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog, tenants=[None, "acme"])

    plan = asyncio.run(run())
    assert len(plan.steps) == 1
    assert plan.steps[0].tenant == "acme"


# --- verify_catalog_migration_plan ---


def test_a_freshly_computed_plan_verifies() -> None:
    catalog = _migration_catalog()
    storage = _StubStorage({None: [_clean_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    assert verify_catalog_migration_plan(plan) is True


def test_a_plan_whose_plan_hash_was_hand_edited_fails_verification() -> None:
    catalog = _migration_catalog()
    storage = _StubStorage({None: [_clean_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    tampered = replace(plan, planHash="sha256:tampered")
    assert verify_catalog_migration_plan(tampered) is False


def test_a_plan_whose_step_content_was_hand_edited_fails_verification() -> None:
    catalog = _no_extra_fields_catalog()
    storage = _StubStorage({None: [_clean_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run())
    tampered_steps = [replace(s, afterStructureHash="sha256:tampered") for s in plan.steps]
    tampered = replace(plan, steps=tampered_steps)
    assert verify_catalog_migration_plan(tampered) is False


# --- apply_catalog_migration ---


@dataclass
class _FakeReplacer:
    returns_none_for: set[str]
    calls: list[dict[str, Any]]

    async def replace(
        self,
        intent_hash: str,
        pinned_spec: UISpec,
        *,
        approver: Principal,
        tenant: str | None = None,
        guard: dict[str, Any] | None = None,
        plan_id: str | None = None,
    ) -> FixationRecord | None:
        self.calls.append(
            {"intentHash": intent_hash, "pinnedSpec": pinned_spec, "approver": approver, "tenant": tenant, "guard": guard, "planId": plan_id}
        )
        if intent_hash in self.returns_none_for:
            return None
        return FixationRecord(
            intentHash=intent_hash,
            canonical="sales.trend",
            structureHash="after-hash",
            pinnedSpec=pinned_spec,
            fixatedAt="2026-02-01T00:00:00Z",
            approver=approver,
            tenant=tenant,
        )


def _no_extra_fields_catalog() -> ResolvedCatalog:
    new_type_no_extra_fields = define_component(
        ComponentDefinition(
            type=NEW_TYPE,
            version="2.0.0",
            description="new kpi card (label only)",
            propsSchema=PropsSchema(
                {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
        )
    )
    return resolve_catalog(core_catalog(), Catalog(components=[new_type_no_extra_fields, _old_clean_type_def()]))


def _no_extra_fields_catalog_with_extra_component() -> ResolvedCatalog:
    """Same rewrite-relevant content as _no_extra_fields_catalog() (so a rewritten pinnedSpec still
    validates cleanly), but with one extra, otherwise-irrelevant component -- a different overall
    fingerprint (for drift tests that want the fingerprint to be the *only* thing that changed)."""
    new_type_no_extra_fields = define_component(
        ComponentDefinition(
            type=NEW_TYPE,
            version="2.0.0",
            description="new kpi card (label only)",
            propsSchema=PropsSchema(
                {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
        )
    )
    extra = define_component(
        ComponentDefinition(
            type="sales.unrelatedWidget",
            version="1.0.0",
            description="unrelated to the migration; present only to change the catalog fingerprint",
            propsSchema=PropsSchema({"type": "object", "properties": {}}),
            capabilities=CapabilityDecl(events=[], data="none", children="none"),
        )
    )
    return resolve_catalog(
        core_catalog(), Catalog(components=[new_type_no_extra_fields, _old_clean_type_def(), extra])
    )


def _no_extra_fields_catalog_tightened() -> ResolvedCatalog:
    """Same type@version as _no_extra_fields_catalog() (so the fingerprint is IDENTICAL), but NEW_TYPE's
    propsSchema additionally requires `currencyCode` -- an in-place propsSchema tightening a fingerprint
    comparison alone cannot catch."""
    tightened = define_component(
        ComponentDefinition(
            type=NEW_TYPE,
            version="2.0.0",
            description="new kpi card (label only)",
            propsSchema=PropsSchema(
                {
                    "type": "object",
                    "properties": {"label": {"type": "string"}, "currencyCode": {"type": "string"}},
                    "required": ["label", "currencyCode"],
                }
            ),
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
        )
    )
    return resolve_catalog(core_catalog(), Catalog(components=[tightened, _old_clean_type_def()]))


def _build_plan() -> CatalogMigrationPlan:
    catalog = _no_extra_fields_catalog()
    storage = _StubStorage({None: [_clean_fixation()]})

    async def run() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    return asyncio.run(run())


APPROVER = Principal(id="reviewer-1")


def test_apply_calls_replace_with_guard_and_plan_hash() -> None:
    plan = _build_plan()
    replacer: CatalogMigrationFixationReplacer = _FakeReplacer(returns_none_for=set(), calls=[])

    async def run() -> CatalogMigrationApplyResult:
        return await apply_catalog_migration(
            plan=plan, fixations=replacer, approver=APPROVER, catalog_for=lambda _t: _no_extra_fields_catalog()
        )

    result = asyncio.run(run())
    calls = replacer.calls  # type: ignore[attr-defined]
    assert len(calls) == 1
    call = calls[0]
    assert call["intentHash"] == INTENT_HASH_CLEAN
    assert call["approver"] == APPROVER
    assert call["planId"] == plan.planHash
    assert call["guard"] == {
        "ifFixatedAt": "2026-01-01T00:00:00Z",
        "ifStructureHash": "clean-before",
        "ifRevision": "rev-clean",
        "ifCatalogFingerprint": "fp-clean-before",
    }
    assert result.applied == [{"intentHash": INTENT_HASH_CLEAN, "tenant": None}]
    assert result.skipped == []
    assert result.blocked == []


def test_apply_reports_a_guard_mismatch_as_skipped() -> None:
    plan = _build_plan()
    replacer: CatalogMigrationFixationReplacer = _FakeReplacer(returns_none_for={INTENT_HASH_CLEAN}, calls=[])

    async def run() -> CatalogMigrationApplyResult:
        return await apply_catalog_migration(
            plan=plan, fixations=replacer, approver=APPROVER, catalog_for=lambda _t: _no_extra_fields_catalog()
        )

    result = asyncio.run(run())
    assert result.applied == []
    assert result.skipped == [{"intentHash": INTENT_HASH_CLEAN, "tenant": None}]
    assert result.blocked == []


def test_apply_never_calls_replace_for_a_step_already_in_plan_blocked() -> None:
    catalog = _migration_catalog()  # NEW_TYPE here requires `format`, so the clean fixation is blocked too
    storage = _StubStorage({None: [_blocked_fixation()]})

    async def run_plan() -> CatalogMigrationPlan:
        return await plan_catalog_migration(storage=storage, catalog_for=lambda _t: catalog)

    plan = asyncio.run(run_plan())
    assert plan.steps == []
    replacer: CatalogMigrationFixationReplacer = _FakeReplacer(returns_none_for=set(), calls=[])

    async def run_apply() -> CatalogMigrationApplyResult:
        return await apply_catalog_migration(
            plan=plan, fixations=replacer, approver=APPROVER, catalog_for=lambda _t: catalog
        )

    result = asyncio.run(run_apply())
    assert replacer.calls == []  # type: ignore[attr-defined]
    assert result.applied == []
    assert result.skipped == []
    assert result.blocked == []


# --- apply_catalog_migration: catalog drift (the catalog changed between plan and apply) ---


def test_apply_refuses_a_step_when_the_live_catalogs_fingerprint_differs_from_the_plans_target() -> None:
    plan = _build_plan()
    drifted_catalog = _no_extra_fields_catalog_with_extra_component()
    replacer: CatalogMigrationFixationReplacer = _FakeReplacer(returns_none_for=set(), calls=[])

    async def run() -> CatalogMigrationApplyResult:
        return await apply_catalog_migration(
            plan=plan, fixations=replacer, approver=APPROVER, catalog_for=lambda _t: drifted_catalog
        )

    result = asyncio.run(run())
    assert replacer.calls == []  # type: ignore[attr-defined]
    assert result.applied == []
    assert result.skipped == []
    assert len(result.blocked) == 1
    entry = result.blocked[0]
    assert entry.intentHash == INTENT_HASH_CLEAN
    assert entry.reason == "catalog-drift"
    assert entry.observedCatalogFingerprint == drifted_catalog.fingerprint
    assert entry.issues == []


def test_apply_refuses_a_step_whose_pinned_spec_fails_revalidation_even_though_the_fingerprint_is_unchanged() -> None:
    plan = _build_plan()
    tightened_catalog = _no_extra_fields_catalog_tightened()
    # Sanity: this is exactly the case fingerprint comparison alone cannot catch.
    assert tightened_catalog.fingerprint == plan.steps[0].targetCatalogFingerprint
    replacer: CatalogMigrationFixationReplacer = _FakeReplacer(returns_none_for=set(), calls=[])

    async def run() -> CatalogMigrationApplyResult:
        return await apply_catalog_migration(
            plan=plan, fixations=replacer, approver=APPROVER, catalog_for=lambda _t: tightened_catalog
        )

    result = asyncio.run(run())
    assert replacer.calls == []  # type: ignore[attr-defined]
    assert result.applied == []
    assert len(result.blocked) == 1
    entry = result.blocked[0]
    assert entry.intentHash == INTENT_HASH_CLEAN
    assert entry.reason == "catalog-drift"
    assert entry.observedCatalogFingerprint == tightened_catalog.fingerprint
    assert len(entry.issues) > 0
    assert "kpi1:" in entry.issues[0]


def test_apply_applies_cleanly_when_the_live_catalog_matches_the_plans_target_exactly() -> None:
    plan = _build_plan()
    replacer: CatalogMigrationFixationReplacer = _FakeReplacer(returns_none_for=set(), calls=[])

    async def run() -> CatalogMigrationApplyResult:
        return await apply_catalog_migration(
            plan=plan, fixations=replacer, approver=APPROVER, catalog_for=lambda _t: _no_extra_fields_catalog()
        )

    result = asyncio.run(run())
    assert result.blocked == []
    assert result.applied == [{"intentHash": INTENT_HASH_CLEAN, "tenant": None}]
