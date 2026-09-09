"""Shared failure-path observability building blocks (port of packages/host-core/src/errors.ts)."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable

from kohaku.composer import ComposeError
from kohaku.spec import QueryRefError, SpecError


def is_typed_host_error(e: object) -> bool:
    """A "typed" error the host's own code (kohaku.spec / kohaku.composer / kohaku.lineage / kohaku.host_core /
    kohaku.host_mcp) produced deliberately, with a message safe and useful to show a client as-is: SpecError
    (Spec parse/patch/validation failures), ComposeError (composition-pipeline failures), QueryRefError
    (query:// URI parse failures), and more generally any exception carrying a string `code` attribute — the
    convention every governance/capability error in this codebase already follows (PromotionNotPublishedError,
    FixationUnsupportedError, ArtifactNotFoundError, etc.). Distinguished from an arbitrary/unexpected
    exception (a raw exception surfacing from DomainPort.invoke, a downstream library failure, etc.), whose
    message may leak internals (SQL fragments, stack-trace text, library-internal wording) and must not reach
    the client verbatim. Port of TS host-core's isTypedHostError (errors.ts).
    """
    if isinstance(e, (SpecError, ComposeError, QueryRefError)):
        return True
    return isinstance(e, BaseException) and isinstance(getattr(e, "code", None), str)


async def _resolve(value: object) -> object:
    """Normalize both sync and async hook return values into something awaitable."""
    if inspect.isawaitable(value):
        return await value
    return value


async def notify_hook[I](hook: Callable[[I], object] | None, info: I) -> None:
    """Calls an optional observability hook with `info`, swallowing both a synchronous raise and an awaited
    failure. Shared building block for both host profiles' failure-path observability (REST's on_error / MCP's
    on_error): silent when the hook is unwired, and a failure from the hook itself must never propagate to the
    delivery or self-healing path it is reporting on.
    """
    if hook is None:
        return
    try:
        await _resolve(hook(info))
    except BaseException:
        # A failure of the observation-only hook must not propagate.
        pass


async def fail_open(
    fn: Callable[[], Awaitable[None]],
    on_failure: Callable[[BaseException], Awaitable[None]],
) -> None:
    """Runs `fn`, and on failure runs `on_failure(error)` instead of re-raising. Shared building block for
    fail-open audit recording (REST's safe_record / MCP's on_composed fail-open wrapper): prioritizes delivery
    availability by swallowing a recording failure rather than letting it take down an otherwise-successful
    response.
    """
    try:
        await fn()
    except BaseException as e:
        await on_failure(e)
