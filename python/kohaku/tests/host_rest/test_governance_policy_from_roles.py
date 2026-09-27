"""Tests for governance_policy_from_roles (port of governance-policy-from-roles.test.ts)."""

from __future__ import annotations

from kohaku.host_rest import GovernanceOperation, governance_policy_from_roles
from kohaku.spec import Principal


def _principal(*roles: str) -> Principal:
    return Principal(id=f"u-{'-'.join(roles)}", roles=list(roles))


def test_evaluates_using_the_roles_roles_for_tenant_returns_for_that_tenant() -> None:
    def roles_for(tenant: str | None) -> dict[str, list[str]]:
        return {"admin": ["*"]} if tenant == "tenant-a" else {"viewer": ["lineage.read"]}

    evaluate = governance_policy_from_roles(roles_for)
    assert evaluate(_principal("admin"), GovernanceOperation(kind="promotion.approve"), "tenant-a") is True
    # Same principal/operation, different tenant -> different roles map -> denied.
    assert evaluate(_principal("admin"), GovernanceOperation(kind="promotion.approve"), "tenant-b") is False


def test_re_resolves_roles_for_on_every_call() -> None:
    """Reflects a live reload, not a snapshot."""
    roles: dict[str, list[str]] = {"viewer": ["lineage.read"]}
    evaluate = governance_policy_from_roles(lambda _tenant: roles)

    assert evaluate(_principal("viewer"), GovernanceOperation(kind="promotion.approve"), None) is False
    roles = {"viewer": ["*"]}
    assert evaluate(_principal("viewer"), GovernanceOperation(kind="promotion.approve"), None) is True


def test_denies_by_default() -> None:
    """An unknown role or an empty roles map matches nothing."""
    evaluate = governance_policy_from_roles(lambda _tenant: {})
    assert evaluate(_principal("admin"), GovernanceOperation(kind="lineage.read"), None) is False


def test_supports_domain_wildcards() -> None:
    """The same way create_governance_policy does."""
    evaluate = governance_policy_from_roles(lambda _tenant: {"reviewer": ["promotion.*"]})
    assert evaluate(_principal("reviewer"), GovernanceOperation(kind="promotion.approve"), None) is True
    assert evaluate(_principal("reviewer"), GovernanceOperation(kind="fixation.remove"), None) is False


def test_role_union_across_multiple_roles_is_allowed_if_any_matches() -> None:
    evaluate = governance_policy_from_roles(
        lambda _tenant: {"viewer": ["lineage.read"], "approver": ["promotion.approve"]}
    )
    assert (
        evaluate(_principal("viewer", "approver"), GovernanceOperation(kind="promotion.approve"), None)
        is True
    )
