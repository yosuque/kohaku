"""Staged (canary) catalog rollout (Port of TS staged.ts, design.md #65).

Builds a catalog_for(tenant) callable that serves `next` only to tenants `in_rollout` admits, `stable` to
everyone else -- including, always, tenant-neutral traffic (tenant None).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .catalog import ResolvedCatalog


@dataclass(frozen=True)
class StagedCatalogOptions:
    """stable and next are each already-resolved (resolve_catalog(core_catalog(), ...)), so a product
    migrating a deprecated part to its replacement can compute `next` once (the catalog after the
    migration) and stage it in behind `in_rollout` before flipping every tenant over."""

    stable: ResolvedCatalog
    """Served to every tenant not in the rollout, and always served for tenant-neutral traffic."""
    next: ResolvedCatalog
    """Served only to a tenant in_rollout admits."""
    in_rollout: Callable[[str], bool]
    """Decides per tenant whether `next` applies. Never consulted for tenant-neutral traffic."""


def staged_catalog_for(options: StagedCatalogOptions) -> Callable[[str | None], ResolvedCatalog]:
    """Returns a (tenant: str | None) -> ResolvedCatalog callable -- the same shape a product's own
    catalog_for resolver already takes.

    Tenant-neutral traffic (tenant None) always gets `stable`, unconditionally: a canary rollout is staged
    in tenant by tenant, and a deployment with no tenant resolution has no rollout list to consult in the
    first place, so it must never be silently opted in.

    Layering with promotions: this function only chooses between the two given *bases* -- it does not
    itself merge in a per-tenant promoted-component contribution. A product that also promotes components
    per tenant applies that layering *after* staged_catalog_for has picked the base: build `stable` and
    `next` as resolve_catalog(...) results that already carry the tenant's promoted entries, or wrap this
    function's result with the product's own promotion merge.
    """

    def catalog_for(tenant: str | None = None) -> ResolvedCatalog:
        if tenant is None:
            return options.stable
        return options.next if options.in_rollout(tenant) else options.stable

    return catalog_for
