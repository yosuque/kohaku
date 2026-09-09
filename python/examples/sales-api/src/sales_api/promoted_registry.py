"""Per-tenant promotion registry (port of TS: apps/sample-api/src/intents/promoted-registry.ts).

Holds the components / Intents added by promotion (publish) per tenant, and derives the per-tenant component catalog
(for compose) and Intent catalog (for NL normalization).

The promotion-state snapshot (promotions.json) is the sole state authority, and this registry is its projection.
It is rebuilt from the snapshot by startup reconcile (promotions.reconcile -> idempotent re-application of on_publish).
on_publish is idempotent (an already-registered (tenant, artifactId) is a no-op), so double application in reconcile is safe.

Omitting tenant (single tenant) aggregates into the empty-string-key bucket (the behavior of existing demos and tests).
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from kohaku.lineage import ComponentDraft
from kohaku.registry import ResolvedCatalog

from .intents_catalog import IntentCatalog
from .promoted import PromotedEntry, promoted_intent

_logger = logging.getLogger(__name__)

_DEFAULT_TENANT_KEY = ""


def _key_of(tenant: str | None) -> str:
    return tenant if tenant is not None else _DEFAULT_TENANT_KEY


class PromotedRegistry:
    """Per-tenant promotion registry."""

    def __init__(
        self,
        build_component_catalog: Callable[[list[PromotedEntry]], ResolvedCatalog],
        core_intent_names: frozenset[str],
    ) -> None:
        """
        build_component_catalog: builds the component catalog including promotions (core (+) contributions (+) promotions).
            Throws on a component_type collision (the validation point of validate-then-commit).
        core_intent_names: core Intent names (reserved words). Used to reject promoted Intents that collide with them.
        """
        self._build_component_catalog = build_component_catalog
        self._core_intent_names = core_intent_names
        self._by_tenant: dict[str, list[PromotedEntry]] = {}
        self._component_catalogs: dict[str, ResolvedCatalog] = {}
        self._intent_catalogs: dict[str, IntentCatalog] = {}

    def entries_for(self, tenant: str | None = None) -> list[PromotedEntry]:
        """The given tenant's promotion entries (a copy; intended read-only)."""
        return list(self._by_tenant.get(_key_of(tenant), []))

    def component_catalog_for(self, tenant: str | None = None) -> ResolvedCatalog:
        """The given tenant's component catalog (for compose; passed to ComposeContext.catalog_for)."""
        k = _key_of(tenant)
        catalog = self._component_catalogs.get(k)
        if catalog is None:
            catalog = self._build_component_catalog(self.entries_for(tenant))
            self._component_catalogs[k] = catalog
        return catalog

    def intent_catalog_for(self, tenant: str | None = None) -> IntentCatalog:
        """The given tenant's Intent catalog (for NL normalization; base core Intents + the tenant's promoted Intents)."""
        k = _key_of(tenant)
        catalog = self._intent_catalogs.get(k)
        if catalog is None:
            catalog = IntentCatalog()  # already initialized with core INTENT_DEFS
            for entry in self.entries_for(tenant):
                catalog.add(promoted_intent(entry))
            self._intent_catalogs[k] = catalog
        return catalog

    def validate_publish(self, tenant: str | None, entry: PromotedEntry) -> None:
        """Pre-check for publish (a pure validation gate, #8).

        Detects name collisions (with core / the tenant's existing promotions) and component_type collisions before the
        snapshot transition. If not publishable, throws an error (never reaching the state transition).
        """
        intent_name = entry.draft.intentName
        if intent_name in self._core_intent_names:
            raise ValueError(f'Intent name "{intent_name}" collides with a core Intent and cannot be promoted')
        if any(e.draft.intentName == intent_name for e in self.entries_for(tenant)):
            raise ValueError(f'Intent name "{intent_name}" collides with an existing promoted Intent and cannot be promoted')
        # A component_type collision is thrown by build_component_catalog (detected in a dry-run before the transition).
        self._build_component_catalog([*self.entries_for(tenant), entry])

    def publish(self, tenant: str | None, entry: PromotedEntry) -> None:
        """The projection application of publish (idempotent, #8). An already-registered (tenant, artifactId) is a no-op (safe for double application in reconcile).

        validate-then-commit: validate on a copy before applying, and on collision skip applying and warn (the snapshot
        authority side stays published and is retried on the next reconcile). Does not throw (the validation gate is
        validate_publish).
        """
        k = _key_of(tenant)
        current = self._by_tenant.get(k, [])
        if any(e.artifactId == entry.artifactId for e in current):
            return  # idempotent
        # Skip Intent-name collisions (with a core Intent or the tenant's existing promotion) (reconcile hardening).
        intent_name = entry.draft.intentName
        if intent_name in self._core_intent_names or any(
            e.draft.intentName == intent_name for e in current
        ):
            _logger.warning(
                "[promoted] %s (intent %s) skipped due to an Intent-name collision",
                entry.artifactId,
                intent_name,
            )
            return
        nxt = [*current, entry]
        try:
            self._build_component_catalog(nxt)  # component_type collision detection (validate-then-commit)
        except Exception as err:  # noqa: BLE001 - skip applying and warn; convergence is left to reconcile
            _logger.warning(
                "[promoted] %s (%s) skipped due to a catalog collision: %s",
                entry.artifactId,
                entry.draft.componentType,
                err,
            )
            return
        self._by_tenant[k] = nxt
        self._invalidate(k)

    def unpublish(self, tenant: str | None, artifact_id: str) -> None:
        """The projection removal of unpublish (symmetric with on_publish). No-op if there is no match (idempotent)."""
        k = _key_of(tenant)
        current = self._by_tenant.get(k, [])
        nxt = [e for e in current if e.artifactId != artifact_id]
        if len(nxt) == len(current):
            return  # no change
        self._by_tenant[k] = nxt
        self._invalidate(k)

    def all_promoted_component_types(self) -> list[str]:
        """The promoted component_types across all tenants (deduplicated). Used for the promoted display of /api/health."""
        types: list[str] = []
        seen: set[str] = set()
        for entries in self._by_tenant.values():
            for e in entries:
                if e.draft.componentType not in seen:
                    seen.add(e.draft.componentType)
                    types.append(e.draft.componentType)
        return types

    def _invalidate(self, k: str) -> None:
        self._component_catalogs.pop(k, None)
        self._intent_catalogs.pop(k, None)


def to_promoted_entry(
    *,
    artifact_id: str,
    draft: ComponentDraft,
    html: str,
    published_at: str,
    request: str | None = None,
) -> PromotedEntry:
    """Assembles a PromotedEntry from the arguments of on_publish / validate_publish (published_at is the application time)."""
    return PromotedEntry(
        artifactId=artifact_id,
        draft=draft,
        html=html,
        request=request,
        publishedAt=published_at,
    )


__all__ = ["PromotedRegistry", "to_promoted_entry"]
