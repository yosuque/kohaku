"""kohaku.host_core.allowed_actions — memoizes the write-action names a DomainPort actually exposes (port of
packages/host-core/src/allowed-actions.ts).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from kohaku.spec import DomainPort

AllowedActions = Callable[[], Awaitable[frozenset[str]]]
"""A memoized accessor for the write-action names a DomainPort actually exposes."""


def create_allowed_actions(
    domain: DomainPort, on_error: Callable[[BaseException], None] | None = None
) -> AllowedActions:
    """Builds a memoizing `AllowedActions` closure for one `DomainPort` — built once per host attach / deps
    object (`list_operations()` is async and must not be re-awaited on every compose / action call). Shared by
    both host profiles wherever a caller-supplied action name must be checked against the DomainPort's real
    operation list:
    - REST/MCP capability issuance (host_core's `issue_capability_for_spec`'s `allowed_actions` option) drops a
      Spec-declared write scope whose action is not a DomainPort operation, hardening against a
      hallucinated/injected `action.invoke` action name becoming a bearer write scope.
    - The MCP `${prefix}_action` tool additionally rejects an unknown action name outright, before even
      attempting capability verification (defense in depth for a host that does not respect the tool's
      app-only visibility hint).

    On rejection nothing is cached, so the next call retries against the DomainPort, and the rejection
    propagates to the caller — each call site decides its own fail-open/fail-closed response and reports it
    under its own endpoint name (REST's `report_host_error` / MCP's `_report_mcp_error` already do this). The
    optional `on_error` is a coarse, endpoint-less observability fallback fired (fire-and-forget, synchronously
    before the rejection propagates) whenever the underlying `list_operations()` call rejects, for a caller
    that has no per-call-site endpoint to report under. Neither current call site passes it — both already
    catch the rejection themselves and report it under their own endpoint name.
    """
    cached: frozenset[str] | None = None

    async def allowed_actions() -> frozenset[str]:
        nonlocal cached
        if cached is not None:
            return cached
        try:
            ops = await domain.list_operations()
        except BaseException as e:
            if on_error is not None:
                on_error(e)
            raise
        cached = frozenset(op.name for op in ops)
        return cached

    return allowed_actions
