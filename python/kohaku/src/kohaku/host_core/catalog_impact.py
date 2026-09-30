"""Catalog-migration impact analysis (design.md #65). Port of packages/host-core/src/catalog-impact.ts.

Read-only: nothing here writes to storage or the catalog -- it is the "what would break / what needs
attention" report a migration is planned from (host_core.catalog_migration's plan_catalog_migration
consumes the same ResolvedCatalog to build an actual rewrite plan; this module only surveys the current
state).

Four independent findings, each catching a different class of problem:
1. fixation_issues -- a fixed (L0) Spec that no longer structurally validates against the current catalog
   (component removed, or its props schema tightened incompatibly). Uses the same ResolvedCatalog.validate()
   kohaku.composer.fixation.materialize_fixation calls on fingerprint mismatch, so "would this fixation
   still be deliverable" matches the real serving path exactly.
2. deprecated_usage -- every catalog entry currently marked deprecated, and where it is still used
   (fixations by intent_hash, promotion candidates of any status by artifact_id) -- advisory, since a
   deprecated part still validates (only generation stops offering it, kohaku.registry.generation).
3. published_promotion_issues -- a *published* promotion candidate whose registered componentType is
   either deprecated or has disappeared from the catalog entirely ("removed": the catalog and the
   promotion-state authority have drifted apart -- a promoted component's catalog registration was dropped
   without withdrawing the promotion itself).
4. origin_kit_mismatches -- a published candidate generated under a design kit other than current_kit
   (PromotionCandidate.origin.kit, generation provenance). Not necessarily broken, but a migration candidate: its markup may
   not match the kit's current class vocabulary.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from kohaku.registry import DeprecationDecl, ResolvedCatalog
from kohaku.spec import FixationRecord, PromotionState, StoragePort


@dataclass(frozen=True)
class CatalogFixationIssue:
    intentHash: str
    issues: list[str]
    tenant: str | None = None


@dataclass(frozen=True)
class CatalogDeprecatedUsagePromotion:
    artifactId: str
    status: str
    tenant: str | None = None


@dataclass(frozen=True)
class CatalogDeprecatedUsageFixation:
    intentHash: str
    tenant: str | None = None


@dataclass
class CatalogDeprecatedUsageEntry:
    type: str
    deprecated: DeprecationDecl
    fixations: list[CatalogDeprecatedUsageFixation] = field(default_factory=list)
    promotions: list[CatalogDeprecatedUsagePromotion] = field(default_factory=list)


@dataclass(frozen=True)
class CatalogPublishedPromotionIssue:
    artifactId: str
    componentType: str
    reason: str  # "deprecated" | "removed"
    tenant: str | None = None
    deprecated: DeprecationDecl | None = None
    """Present only when reason is "deprecated" (a "removed" type has no catalog entry to read it from)."""


@dataclass(frozen=True)
class CatalogOriginKitMismatch:
    artifactId: str
    kit: dict[str, str]
    currentKit: dict[str, str]
    tenant: str | None = None


@dataclass
class CatalogImpactReport:
    fixationIssues: list[CatalogFixationIssue] = field(default_factory=list)
    deprecatedUsage: list[CatalogDeprecatedUsageEntry] = field(default_factory=list)
    publishedPromotionIssues: list[CatalogPublishedPromotionIssue] = field(default_factory=list)
    originKitMismatches: list[CatalogOriginKitMismatch] = field(default_factory=list)


def _component_type_of(state: PromotionState) -> str | None:
    """Reads a promotion state's best-known componentType: the publish-time projection
    (data['componentType'], #9) when present, else the draft's own (data['draft']['componentType']) for a
    not-yet-published candidate."""
    direct = state.data.get("componentType")
    if isinstance(direct, str):
        return direct
    draft = state.data.get("draft")
    if isinstance(draft, dict):
        component_type = draft.get("componentType")
        if isinstance(component_type, str):
            return component_type
    return None


def _origin_kit_of(state: PromotionState) -> dict[str, str] | None:
    """Reads a promotion state's origin.kit (generation provenance), when present."""
    origin = state.data.get("origin")
    if not isinstance(origin, dict):
        return None
    kit = origin.get("kit")
    if not isinstance(kit, dict):
        return None
    kit_id, version = kit.get("id"), kit.get("version")
    if not isinstance(kit_id, str) or not isinstance(version, str):
        return None
    return {"id": kit_id, "version": version}


def _fixation_issues_for(catalog: ResolvedCatalog, fixation: FixationRecord) -> list[str]:
    result = catalog.validate(
        [c.to_wire() for c in fixation.pinnedSpec.components],
        [e.to_wire() for e in fixation.pinnedSpec.events],
    )
    return [f"{i.componentId}: {i.message}" for i in result.issues]


async def analyze_catalog_impact(
    *,
    storage: StoragePort,
    catalog_for: Any,
    tenants: Sequence[str | None] | None = None,
    current_kit: dict[str, str] | None = None,
) -> CatalogImpactReport:
    """Surveys the impact a catalog migration would have across one or more tenants: broken fixations,
    deprecated-part usage (with where it's used), published promotions on a deprecated/removed part, and
    published promotions whose generation kit no longer matches current_kit. Every list is empty rather
    than omitted when nothing was found, so a caller can render "no issues" without a presence check.

    `catalog_for` is `Callable[[str | None], ResolvedCatalog]` (sync) -- typed as `Any` above only because
    a `Callable` alias here would force every call site to import ResolvedCatalog just to satisfy mypy's
    parameter variance; the runtime contract is exactly TS's `catalogFor` (ComposeContext).
    """
    tenant_sweep: Sequence[str | None] = tenants if tenants is not None else [None]

    fixation_issues: list[CatalogFixationIssue] = []
    deprecated_by_type: dict[str, CatalogDeprecatedUsageEntry] = {}
    published_promotion_issues: list[CatalogPublishedPromotionIssue] = []
    origin_kit_mismatches: list[CatalogOriginKitMismatch] = []

    for tenant in tenant_sweep:
        catalog: ResolvedCatalog = catalog_for(tenant)
        deprecated_types: dict[str, DeprecationDecl] = {
            d.type: d.deprecated for d in catalog.list() if d.deprecated is not None
        }

        fixations, promotions = await asyncio.gather(
            storage.list_fixations(tenant), storage.list_promotion_states(tenant)
        )

        for fixation in fixations:
            issues = _fixation_issues_for(catalog, fixation)
            if len(issues) > 0:
                fixation_issues.append(
                    CatalogFixationIssue(intentHash=fixation.intentHash, tenant=tenant, issues=issues)
                )
            for node in fixation.pinnedSpec.components:
                deprecated = deprecated_types.get(node.type)
                if deprecated is None:
                    continue
                entry = deprecated_by_type.setdefault(
                    node.type, CatalogDeprecatedUsageEntry(type=node.type, deprecated=deprecated)
                )
                entry.fixations.append(
                    CatalogDeprecatedUsageFixation(intentHash=fixation.intentHash, tenant=tenant)
                )

        for state in promotions:
            component_type = _component_type_of(state)
            if component_type is None:
                continue

            deprecated = deprecated_types.get(component_type)
            if deprecated is not None:
                entry = deprecated_by_type.setdefault(
                    component_type, CatalogDeprecatedUsageEntry(type=component_type, deprecated=deprecated)
                )
                entry.promotions.append(
                    CatalogDeprecatedUsagePromotion(
                        artifactId=state.artifactId, tenant=tenant, status=state.status
                    )
                )

            if state.status != "published":
                continue

            if deprecated is not None:
                published_promotion_issues.append(
                    CatalogPublishedPromotionIssue(
                        artifactId=state.artifactId,
                        tenant=tenant,
                        componentType=component_type,
                        reason="deprecated",
                        deprecated=deprecated,
                    )
                )
            elif catalog.get(component_type) is None:
                published_promotion_issues.append(
                    CatalogPublishedPromotionIssue(
                        artifactId=state.artifactId,
                        tenant=tenant,
                        componentType=component_type,
                        reason="removed",
                    )
                )

            if current_kit is not None:
                kit = _origin_kit_of(state)
                if kit is not None and (kit["id"] != current_kit["id"] or kit["version"] != current_kit["version"]):
                    origin_kit_mismatches.append(
                        CatalogOriginKitMismatch(
                            artifactId=state.artifactId, tenant=tenant, kit=kit, currentKit=current_kit
                        )
                    )

    return CatalogImpactReport(
        fixationIssues=fixation_issues,
        deprecatedUsage=list(deprecated_by_type.values()),
        publishedPromotionIssues=published_promotion_issues,
        originKitMismatches=origin_kit_mismatches,
    )
