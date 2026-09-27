"""Catalog migration: planning + applying a bulk rewrite of fixated (L0) Specs from a deprecated part onto
its replacement (design.md #65). Port of packages/host-core/src/catalog-migration.ts.

Two-phase, mirroring the promotion pipeline's own separation of "compute what would happen" from
"commit it":

- plan_catalog_migration is read-only. For every deprecated catalog entry that declares replacedBy, it
  finds every fixation (per tenant) referencing that type, rewrites the matching nodes' type (and version,
  when replacedBy.version is pinned) and props (via the part's migrateProps -- TS-only; see
  kohaku.registry's DeprecationDecl doc, so Python catalogs never carry one and this always leaves props
  untouched), then revalidates the rewritten Spec against the *target* catalog with
  ResolvedCatalog.validate -- the same check kohaku.composer.fixation.materialize_fixation runs on a
  fingerprint mismatch. A fixation that fails revalidation is reported in `blocked` instead of `steps`,
  never silently dropped.
- apply_catalog_migration commits a previously computed plan's `steps` through a host-supplied
  fixation-replace surface (structurally kohaku.lineage's Fixations.replace -- see
  CatalogMigrationFixationReplacer's doc for why this is a structural Protocol rather than an import;
  host_core must not depend on lineage). Each step's before-structure-hash / before-revision become a
  TOCTOU guard, so a fixation that moved on since the plan was built is skipped rather than clobbered.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from kohaku.registry import ResolvedCatalog
from kohaku.spec import (
    ComponentNode,
    FixationRecord,
    Principal,
    StoragePort,
    UISpec,
    canonical_stringify,
    compute_structure_hash,
    sha256_hex,
)


@dataclass(frozen=True)
class CatalogMigrationRewrite:
    """The deprecated type being migrated away from, and the replacement it resolves to."""

    from_: str
    to: dict[str, str]  # {"type": ..., "version"?: ...}


@dataclass(frozen=True)
class CatalogMigrationStep:
    intentHash: str
    beforeStructureHash: str
    beforeFixatedAt: str
    pinnedSpec: UISpec
    afterStructureHash: str
    rewrittenNodeIds: list[str]
    tenant: str | None = None
    beforeRevision: str | None = None


@dataclass(frozen=True)
class CatalogMigrationBlocked:
    intentHash: str
    types: list[str]
    issues: list[str]
    tenant: str | None = None


@dataclass(frozen=True)
class CatalogMigrationPlan:
    planHash: str
    rewrites: list[CatalogMigrationRewrite] = field(default_factory=list)
    steps: list[CatalogMigrationStep] = field(default_factory=list)
    blocked: list[CatalogMigrationBlocked] = field(default_factory=list)


def _rewrite_node(node: ComponentNode, to: dict[str, str]) -> ComponentNode:
    """Rewrites a node's type/version. Props are left untouched: TS's migrateProps is a function and has
    no Python counterpart (kohaku.registry.types.DeprecationDecl's doc)."""
    return node.model_copy(update={"type": to["type"], "version": to.get("version")})


def _compute_plan_hash(
    rewrites: list[CatalogMigrationRewrite],
    steps: list[CatalogMigrationStep],
    blocked: list[CatalogMigrationBlocked],
) -> str:
    """Canonical, content-addressed hash over a plan's identifying fields (never the full pinnedSpec of
    each step -- only the before/after structure hashes and which nodes moved)."""
    material = {
        "rewrites": [{"from": r.from_, "to": r.to} for r in rewrites],
        "steps": sorted(
            (
                {
                    "intentHash": s.intentHash,
                    "tenant": s.tenant,
                    "beforeStructureHash": s.beforeStructureHash,
                    "afterStructureHash": s.afterStructureHash,
                    "rewrittenNodeIds": sorted(s.rewrittenNodeIds),
                }
                for s in steps
            ),
            key=lambda s: s["intentHash"],  # type: ignore[arg-type,return-value]
        ),
        "blocked": sorted(
            (
                {"intentHash": b.intentHash, "tenant": b.tenant, "types": sorted(b.types)}
                for b in blocked
            ),
            key=lambda b: b["intentHash"],  # type: ignore[arg-type,return-value]
        ),
    }
    return f"sha256:{sha256_hex(canonical_stringify(material))}"


async def plan_catalog_migration(
    *,
    storage: StoragePort,
    catalog_for: Any,
    tenants: Sequence[str | None] | None = None,
    types: Sequence[str] | None = None,
) -> CatalogMigrationPlan:
    """Surveys every tenant's fixations for uses of a deprecated-with-replacement catalog type, rewrites
    them, and revalidates the result. Read-only: nothing is written to storage.

    `catalog_for` is `Callable[[str | None], ResolvedCatalog]` (sync) -- typed as `Any` for the same reason
    as host_core.catalog_impact.analyze_catalog_impact's own `catalog_for` parameter.
    """
    tenant_sweep: Sequence[str | None] = tenants if tenants is not None else [None]

    rewrite_by_type: dict[str, CatalogMigrationRewrite] = {}
    steps: list[CatalogMigrationStep] = []
    blocked: list[CatalogMigrationBlocked] = []

    for tenant in tenant_sweep:
        catalog: ResolvedCatalog = catalog_for(tenant)
        migration_map: dict[str, dict[str, str]] = {}
        for definition in catalog.list():
            deprecated = definition.deprecated
            replaced_by = deprecated.replacedBy if deprecated is not None else None
            if replaced_by is None:
                continue
            if types is not None and definition.type not in types:
                continue
            replacement: dict[str, str] = {"type": replaced_by.type}
            if replaced_by.version is not None:
                replacement["version"] = replaced_by.version
            migration_map[definition.type] = replacement
            rewrite_by_type.setdefault(
                definition.type, CatalogMigrationRewrite(from_=definition.type, to=replacement)
            )
        if len(migration_map) == 0:
            continue

        fixations = await storage.list_fixations(tenant)
        for fixation in fixations:
            rewritten_node_ids: list[str] = []
            touched_types: set[str] = set()
            rewritten_components: list[ComponentNode] = []
            for node in fixation.pinnedSpec.components:
                match = migration_map.get(node.type)
                if match is None:
                    rewritten_components.append(node)
                    continue
                rewritten_node_ids.append(node.id)
                touched_types.add(node.type)
                rewritten_components.append(_rewrite_node(node, match))
            if len(rewritten_node_ids) == 0:
                continue  # this fixation does not reference any migrated type

            new_pinned_spec = fixation.pinnedSpec.model_copy(update={"components": rewritten_components})
            result = catalog.validate(
                [c.to_wire() for c in new_pinned_spec.components],
                [e.to_wire() for e in new_pinned_spec.events],
            )
            if len(result.issues) > 0:
                blocked.append(
                    CatalogMigrationBlocked(
                        intentHash=fixation.intentHash,
                        tenant=tenant,
                        types=sorted(touched_types),
                        issues=[f"{i.componentId}: {i.message}" for i in result.issues],
                    )
                )
                continue

            steps.append(
                CatalogMigrationStep(
                    intentHash=fixation.intentHash,
                    tenant=tenant,
                    beforeStructureHash=fixation.structureHash,
                    beforeRevision=fixation.revision,
                    beforeFixatedAt=fixation.fixatedAt,
                    pinnedSpec=new_pinned_spec,
                    afterStructureHash=compute_structure_hash(new_pinned_spec),
                    rewrittenNodeIds=rewritten_node_ids,
                )
            )

    rewrites = list(rewrite_by_type.values())
    return CatalogMigrationPlan(
        planHash=_compute_plan_hash(rewrites, steps, blocked), rewrites=rewrites, steps=steps, blocked=blocked
    )


class CatalogMigrationFixationReplacer(Protocol):
    """Structural counterpart of kohaku.lineage's Fixations.replace -- declared locally (rather than
    imported) because host_core must not depend on lineage (dependency direction; lineage sits above
    host_core). The concrete Fixations class satisfies this shape as-is."""

    async def replace(
        self,
        intent_hash: str,
        pinned_spec: UISpec,
        *,
        approver: Principal,
        tenant: str | None = None,
        guard: dict[str, Any] | None = None,
        plan_id: str | None = None,
    ) -> FixationRecord | None: ...


@dataclass(frozen=True)
class CatalogMigrationApplyResult:
    applied: list[dict[str, str | None]] = field(default_factory=list)
    skipped: list[dict[str, str | None]] = field(default_factory=list)


async def apply_catalog_migration(
    *,
    plan: CatalogMigrationPlan,
    fixations: CatalogMigrationFixationReplacer,
    approver: Principal,
) -> CatalogMigrationApplyResult:
    """Commits a plan's `steps` (never `blocked`). Each replace call is independently guarded by that
    step's own before-structure-hash / before-revision / before-fixated-at, so applying a plan is safe to
    run even if some fixations changed underneath it since planning -- those are reported in `skipped`."""
    applied: list[dict[str, str | None]] = []
    skipped: list[dict[str, str | None]] = []

    for step in plan.steps:
        guard: dict[str, Any] = {"ifFixatedAt": step.beforeFixatedAt, "ifStructureHash": step.beforeStructureHash}
        if step.beforeRevision is not None:
            guard["ifRevision"] = step.beforeRevision
        result = await fixations.replace(
            step.intentHash,
            step.pinnedSpec,
            approver=approver,
            tenant=step.tenant,
            guard=guard,
            plan_id=plan.planHash,
        )
        entry = {"intentHash": step.intentHash, "tenant": step.tenant}
        if result is None:
            skipped.append(entry)
        else:
            applied.append(entry)

    return CatalogMigrationApplyResult(applied=applied, skipped=skipped)
