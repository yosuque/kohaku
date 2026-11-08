"""Shared capability issuance for a composed Spec (port of packages/host-core/src/capability.ts)."""

from __future__ import annotations

import inspect
import weakref
from collections.abc import Callable

from kohaku.spec import (
    DEFAULT_CAPABILITY_TTL_SECONDS,
    AuthzPort,
    Principal,
    Scope,
    UISpec,
    collect_capability_scopes,
)

# DEFAULT_CAPABILITY_TTL_SECONDS (the default capability lifetime when a host does not override it, shared by
# the REST and MCP profiles) is defined in kohaku.spec, like TS's spec-core, so an AuthzPort implementation
# (kohaku.authz_hmac) can use it without importing this layer; `host_core` re-exports it for existing callers.


_TENANT_SUPPORT_CACHE: weakref.WeakKeyDictionary[Callable[..., object], bool] = (
    weakref.WeakKeyDictionary()
)


def authz_accepts_tenant(authz: AuthzPort) -> bool:
    """Whether `authz.issue_capability` can be called with a `tenant` keyword (SPEC CAP-TEN-001): it names a
    `tenant` parameter or takes `**kwargs`. Determined by `inspect.signature` (never by catching a TypeError
    from a real call, which could mask an unrelated bug inside the port), once per underlying function: the
    answer is cached, so a host that asks on every request pays for the inspection once. A port written
    before the `tenant` keyword existed answers False; the host then issues without a tenant binding."""
    method = authz.issue_capability
    key: Callable[..., object] = getattr(method, "__func__", method)
    try:
        cached = _TENANT_SUPPORT_CACHE.get(key)
    except TypeError:  # not weak-referenceable: inspect on every call
        cached = None
    if cached is not None:
        return cached
    try:
        params = inspect.signature(method).parameters.values()
    except (TypeError, ValueError):
        # No introspectable signature (a C callable, say): assume the contract is honoured.
        return True
    accepts = any(
        p.kind is inspect.Parameter.VAR_KEYWORD
        or (
            p.name == "tenant"
            and p.kind in (inspect.Parameter.KEYWORD_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        )
        for p in params
    )
    try:
        _TENANT_SUPPORT_CACHE[key] = accepts
    except TypeError:
        pass
    return accepts


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
    tenant: str | None = None,
) -> str:
    """Issues a capability matching the Spec's declarations (components' read references + the write-through
    action path). The scope-collection rules (read = bind variant enumeration / write = declared actions /
    variant cap) are centralized in kohaku.spec's collect_capability_scopes (single source of truth), so both
    host profiles agree on the issuance rule.

    When allowed_actions is given, write scopes whose action is not a DomainPort operation
    (list_operations()) are dropped before issuance — hardening against an LLM-generated action.invoke action
    name flowing unvalidated into a bearer write scope. Read scopes are untouched by this filter.

    `tenant` is the tenant to bind into the capability (SPEC CAP-TEN-001), when the host resolved one. The
    `tenant=` keyword is passed to `authz.issue_capability` only when set and only when the port's signature
    accepts it (`authz_accepts_tenant`): a port that predates the option sees exactly the call shape it always
    did and the capability is issued without a tenant binding (the host reports that once; see host_rest).
    """
    scopes = _filter_allowed_scopes(
        collect_capability_scopes(spec), allowed_actions, on_dropped_action
    )
    if tenant is None or not authz_accepts_tenant(authz):
        return await authz.issue_capability(principal, scopes, ttl_seconds=ttl_seconds)
    return await authz.issue_capability(principal, scopes, ttl_seconds=ttl_seconds, tenant=tenant)
