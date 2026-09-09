"""Shared capability issuance for a composed Spec (port of packages/host-core/src/capability.ts)."""

from __future__ import annotations

from collections.abc import Callable

from kohaku.spec import AuthzPort, Principal, Scope, UISpec, collect_capability_scopes

# Default capability TTL (seconds) when a host does not override it. Shared by the REST and MCP profiles.
DEFAULT_CAPABILITY_TTL_SECONDS = 600


class WriteScopeDroppedError(ValueError):
    """Raised (reported via on_dropped_action, never actually raised into the caller) when a Spec-declared
    write scope's action name is not among the DomainPort's list_operations() names. A hallucinated/injected
    action.invoke action name must not become a bearer write scope, so it is silently excluded from the
    issued capability rather than granted — issue_capability_for_spec itself stays fail-open (the capability
    is still issued without that one scope).
    """

    def __init__(self, action: str) -> None:
        super().__init__(
            f'write scope dropped: action "{action}" is not a DomainPort operation (list_operations)'
        )
        self.action = action


def _filter_allowed_scopes(
    scopes: list[Scope],
    allowed_actions: frozenset[str] | None,
    on_dropped_action: Callable[[str], None] | None,
) -> list[Scope]:
    """Drops write scopes not covered by allowed_actions (a no-op when it is None)."""
    if allowed_actions is None:
        return scopes
    kept: list[Scope] = []
    for scope in scopes:
        if scope.kind != "write" or scope.ref in allowed_actions:
            kept.append(scope)
        elif on_dropped_action is not None:
            on_dropped_action(scope.ref)
    return kept


async def issue_capability_for_spec(
    authz: AuthzPort,
    principal: Principal,
    spec: UISpec,
    ttl_seconds: int = DEFAULT_CAPABILITY_TTL_SECONDS,
    *,
    allowed_actions: frozenset[str] | None = None,
    on_dropped_action: Callable[[str], None] | None = None,
) -> str:
    """Issues a capability matching the Spec's declarations (components' read references + the write-through
    action path). The scope-collection rules (read = bind variant enumeration / write = declared actions /
    variant cap) are centralized in kohaku.spec's collect_capability_scopes (single source of truth), so both
    host profiles agree on the issuance rule.

    When allowed_actions is given, write scopes whose action is not a DomainPort operation
    (list_operations()) are dropped before issuance — hardening against an LLM-generated action.invoke action
    name flowing unvalidated into a bearer write scope. Read scopes are untouched by this filter.
    """
    scopes = _filter_allowed_scopes(collect_capability_scopes(spec), allowed_actions, on_dropped_action)
    return await authz.issue_capability(principal, scopes, ttl_seconds=ttl_seconds)
