"""Declarative RBAC policy evaluator for the governance/audit plane (port of governance-policy.ts).

`KohakuHostDeps.authorize_governance` has the framework prescribe only the "authorization confluence point"
(SPEC §6.1 governance plane authorization [Draft]); the evaluator implementation is a product responsibility. This
module supplies, as a representative implementation, an evaluator that lets you declaratively write a
"role -> permitted operation" matrix.

Design principles:
- The evaluator is a pure function `(principal, operation, tenant?) -> allow/deny`. Extracting the principal (roles,
  etc.) from the request is the hook-wiring side's (`KohakuHostDeps.auth`) responsibility; the evaluator looks only at
  principal.roles.
- The default is "deny" (deny-by-default). An operation matching none of any role's patterns is denied (as are an
  unknown role and having no roles). A forgotten permission becomes "deny", not "unprotected".
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from kohaku.spec import Principal

# The actual set of governance/audit plane operation.kind values (the kinds require_governance in `routes.py` issues).
# `<domain>.<action>` form. This is the single source of truth for operation.kind.
GOVERNANCE_OPERATION_KINDS: tuple[str, ...] = (
    "lineage.read",
    "analytics.read",
    "telemetry.write",
    "promotion.list",
    "promotion.evaluate",
    "promotion.get",
    "promotion.preview",
    "promotion.approve",
    "promotion.reject",
    "promotion.withdraw",
    "promotion.act",
    # Governance kind for POST /promotions/reconcile (#11): an operator escape hatch that forces the
    # projection recovery from snapshot authority on demand (the same recovery run at startup). Not scoped to
    # one artifact (it scans every tenant), so it is a dedicated kind rather than reusing promotion.act's
    # per-artifact shape. A role granted via promotion.* or * already covers it.
    "promotion.reconcile",
    # Kind-scoped authorization for the generic action route (POST /promotions/{artifact_id}/actions): a
    # caller holding only promotion.act must not be able to record a judge verdict (judge.result), which
    # would let it spoof the judge outcome the dedicated approve flow relies on. promotion.act remains the
    # blanket check for the route; this is the additional kind required specifically for judge.result.
    "promotion.judge",
    "fixation.list",
    "fixation.proposals",
    "fixation.approve",
    "fixation.remove",
)


@dataclass(frozen=True)
class GovernanceOperation:
    """A description of the governance operation a route issues. require_governance receives this type."""

    kind: str
    artifactId: str | None = None
    intentHash: str | None = None


@dataclass(frozen=True)
class GovernancePolicy:
    """A declarative RBAC policy. A matrix of role name -> permitted patterns.

    Example: `GovernancePolicy(roles={"admin": ["*"], "reviewer": ["promotion.*", "lineage.read"]})`
    Patterns support an exact operation.kind, `<domain>.*` (all within a domain), and `*` (all).
    """

    roles: dict[str, list[str]]
    # Optional tenant-scoping hook. When supplied, the evaluator additionally requires
    # `tenant_of(principal) == tenant` (the resolved tenant the route passes in) for every operation — a
    # mismatch denies regardless of role, so a role grant alone can no longer reach another tenant's
    # governance/audit plane. Leave unset (None) to keep the historical role-only behavior (a role holder may
    # operate on any tenant the host resolves). Port of TS governance-policy.ts's GovernancePolicy.tenantOf.
    tenant_of: Callable[[Principal], str | None] | None = None


# The governance plane authorization evaluator (a pure function assignable to `KohakuHostDeps.authorize_governance`).
# operation.kind is received as str — a kind outside the actual set matches no pattern and is denied.
GovernanceEvaluator = Callable[[Principal, GovernanceOperation, str | None], bool]


def create_governance_policy(policy: GovernancePolicy) -> GovernanceEvaluator:
    """Build an authorization evaluator from a declarative RBAC policy.

    Allowed if any of principal.roles matches (multiple roles union their permissions = standard RBAC).
    Denied if no role matches.

    Scope note: without `policy.tenant_of`, the bundled evaluator is **role-based only** and ignores the
    tenant argument (the third parameter of GovernanceEvaluator) — a principal holding a role may operate on
    any tenant the host resolves. Supplying `tenant_of` closes that gap by additionally requiring
    `tenant_of(principal) == tenant` (checked before the role match, so a tenant mismatch denies outright
    regardless of role); leave it unset, or supply your own evaluator, if you need a different tenant-binding
    rule.
    """

    def evaluate(
        principal: Principal, operation: GovernanceOperation, tenant: str | None = None
    ) -> bool:
        if policy.tenant_of is not None and policy.tenant_of(principal) != tenant:
            return False
        roles = principal.roles if principal.roles is not None else []
        for role in roles:
            patterns = policy.roles.get(role)
            if patterns is None:
                continue  # an unknown role has no permissions (fall to the deny side)
            for pattern in patterns:
                if _matches_pattern(pattern, operation.kind):
                    return True
        return False

    return evaluate


def _matches_pattern(pattern: str, kind: str) -> bool:
    """Match a pattern against operation.kind. `*` allows all, `<domain>.*` allows all within a domain, else exact match."""
    if pattern == "*":
        return True
    if pattern.endswith(".*"):
        domain = pattern[:-2]  # the domain with ".*" removed
        return kind.startswith(f"{domain}.")
    return pattern == kind
