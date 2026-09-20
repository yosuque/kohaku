"""Preresolution of a composed Spec's bound refs, co-embedded in a tool result's `_meta`.

Port of packages/host-mcp-apps/src/initial-data.ts. Split out of server.py (mechanical file-layout split,
Task 6) — `_snapshot_html_for` (the self-contained-snapshot ref set, unbudgeted) stays in server.py and reuses
`_resolve_refs_bounded` from here, matching TS's snapshot.ts reusing initial-data.ts's `resolveRefsBounded`.

Error reporting here goes straight through kohaku.host_core's `notify_hook` (not server.py's `_report_mcp_error`,
which stays local to server.py to avoid an import back down to this module) — same `{endpoint, error}` shape and
swallow-on-throw semantics, and the same choice TS's initial-data.ts documents for its own `resolveOne` (see that
function's doc comment: "avoids a circular import back to server.ts").
"""

from __future__ import annotations

import asyncio
import json
from typing import cast

from kohaku.host_core import ParsedInvokableRefOk, parse_invokable_ref
from kohaku.host_core import notify_hook as _host_core_notify_hook
from kohaku.spec import (
    InvocationContext,
    Principal,
    TabularData,
    UISpec,
    enumerate_bind_variants,
    parse_query_ref,
)

from .types import McpErrorInfo, McpHostDeps

# Cumulative size budget (JSON characters) for the initial data co-embedded in the tool result's `_meta`.
# Claude-family hosts spill tool results over about 150k characters to the sandbox side and the widget does not
# hydrate, so cut off at 100k characters, leaving room for the structured Spec + text fallback.
INITIAL_DATA_BUDGET_CHARS = 100_000

# Per-ref timeout (seconds; same value as TS PRERESOLVE_TIMEOUT_MS = 2000) for initial-data preresolution.
# So a slow / unresponsive ref does not block the compose response, a timeout is treated as skip (that ref is not
# co-embedded), the same as the existing per-ref fail-open.
PRERESOLVE_TIMEOUT_S = 2.0

# Bounded concurrency (ops; mirrors TS PRERESOLVE_CONCURRENCY) for _preresolve_initial_data's ref resolution.
# Refs are resolved concurrently (up to this many in flight at once) rather than serially, so one slow-but-not-
# hung DomainPort call no longer holds up the others; the budget below is still applied afterward in the fixed
# initial-then-secondary order, so which refs end up embedded on overflow does not depend on completion order.
PRERESOLVE_CONCURRENCY = 8

# Overall wall-clock deadline (seconds; ops; mirrors TS PRERESOLVE_TOTAL_TIMEOUT_MS) for the whole
# _preresolve_initial_data call, on top of the per-ref timeout above. With up to 256 bind variants across many
# components, even healthy-but-slow resolutions can push total latency well past what a tool caller will wait
# for. Once this elapses, no further refs are started, and any still-in-flight resolution's eventual result
# (success or failure) is discarded rather than embedded — reported through the same per-ref fail-open on_error
# path as an ordinary per-ref failure, with a message identifying it as a deadline discard.
PRERESOLVE_TOTAL_TIMEOUT_S = 10.0


async def _resolve_variant(
    variant: str, deps: McpHostDeps, principal: Principal
) -> TabularData | None:
    """Shared helper that preresolves a single effective ref with read. An unknown source is None (not co-embedded).

    Pure parse/merge via host_core's parse_invokable_ref (shared with the REST/MCP resolve_binding sites).
    Deliberately no verify step here (this is preresolution, not a caller-supplied capability check) — an
    unknown source still yields None (not an embedding target) rather than a raised error.
    """
    parsed = parse_invokable_ref(variant, deps.query_source)
    if not isinstance(parsed, ParsedInvokableRefOk):
        return None
    base, params = parsed.ref.base, parsed.ref.params
    resolved = await deps.domain.invoke(
        base.path,
        params,
        InvocationContext(principal=principal),
    )
    return cast(TabularData, resolved)


class _PreresolveDeadline:
    """Mutable flag shared by every in-flight `_resolve_ref_bounded` call for one `_preresolve_initial_data`
    invocation (a plain object rather than a closure `nonlocal`, since the flag must be visible to tasks
    created before it is set). Mirrors TS resolveRefsBounded's `deadlineExceeded` local."""

    __slots__ = ("exceeded",)

    def __init__(self) -> None:
        self.exceeded = False


async def _resolve_ref_bounded(
    ref: str,
    deps: McpHostDeps,
    principal: Principal,
    semaphore: asyncio.Semaphore,
    results: dict[str, TabularData],
    deadline: _PreresolveDeadline,
    timeout_s: float,
) -> None:
    """Resolves one ref under the shared concurrency semaphore, writing a successful result into `results`.

    Once `deadline.exceeded` is set (the overall preresolution deadline elapsed), a task that has not started
    its DomainPort call yet skips it entirely, and a task already in flight discards its eventual outcome
    (success or failure) instead of writing to `results` — reported via the same per-ref fail-open path as an
    ordinary failure, with a message identifying it as a deadline discard. Mirrors TS's resolveOne.

    `timeout_s` is a parameter (rather than the module-level PRERESOLVE_TIMEOUT_S constant) so
    _resolve_refs_bounded can share this exact primitive between _preresolve_initial_data and
    _snapshot_html_for — both pass PRERESOLVE_TIMEOUT_S today, but keeping it a parameter avoids a
    hidden coupling to that specific caller.
    """
    async with semaphore:
        if deadline.exceeded:
            return
        try:
            # per-ref timeout: cut off so a ref that never returns does not hold its concurrency slot forever.
            resolved = await asyncio.wait_for(
                _resolve_variant(ref, deps, principal), timeout=timeout_s
            )
        except Exception as exc:  # noqa: BLE001 — per-ref fail-open (including timeout)
            if deadline.exceeded:
                await _host_core_notify_hook(
                    deps.on_error,
                    McpErrorInfo(endpoint="compose.initialData", error=_discard_error(ref, exc)),
                )
            else:
                await _host_core_notify_hook(
                    deps.on_error, McpErrorInfo(endpoint="compose.initialData", error=exc)
                )
            return
        if deadline.exceeded:
            # Resolved successfully, but too late: the caller already stopped waiting and moved on.
            await _host_core_notify_hook(
                deps.on_error, McpErrorInfo(endpoint="compose.initialData", error=_discard_error(ref))
            )
            return
        if resolved is None:
            return  # do not co-embed an unknown source
        results[ref] = resolved


def _discard_error(ref: str, cause: BaseException | None = None) -> RuntimeError:
    """Builds the observability-hook error for a ref discarded by the overall preresolution deadline (ops)."""
    detail = f" ({cause})" if cause is not None else ""
    return RuntimeError(
        f"Initial-data preresolution discarded (total deadline {PRERESOLVE_TOTAL_TIMEOUT_S}s "
        f"exceeded before this ref resolved): {ref}{detail}"
    )


async def _resolve_refs_bounded(
    refs: list[str],
    deps: McpHostDeps,
    principal: Principal,
    *,
    timeout_s: float,
    total_timeout_s: float,
) -> dict[str, TabularData]:
    """Resolves `refs` with bounded concurrency (PRERESOLVE_CONCURRENCY workers via a Semaphore) subject to an
    overall wall-clock deadline (`total_timeout_s`), on top of a per-ref timeout (`timeout_s`). Port of TS
    initial-data.ts's resolveRefsBounded, shared here by _preresolve_initial_data (the `_meta` co-embed) and
    _snapshot_html_for (the self-contained-snapshot ref set) so a single hung DomainPort dependency can no
    longer stall either one — previously (§2 #6) _snapshot_html_for resolved refs one at a time with neither a
    per-ref timeout nor an overall deadline, so one stuck ref stopped render_snapshot from ever returning.

    Once `total_timeout_s` elapses, no further refs are claimed and any still-in-flight resolution's eventual
    outcome is discarded (see _resolve_ref_bounded). Returns whatever resolved in time; a ref missing from the
    result is either an unknown source (deliberately not embeddable), a genuine per-ref failure/timeout, or a
    deadline discard — callers that need to tell these apart pre-filter unknown-source refs before calling this
    (see _snapshot_html_for).
    """
    resolved: dict[str, TabularData] = {}
    if not refs:
        return resolved
    semaphore = asyncio.Semaphore(PRERESOLVE_CONCURRENCY)
    deadline = _PreresolveDeadline()
    tasks = [
        asyncio.ensure_future(
            _resolve_ref_bounded(ref, deps, principal, semaphore, resolved, deadline, timeout_s)
        )
        for ref in refs
    ]
    # asyncio.wait (unlike wait_for) does not cancel pending tasks on timeout: any ref still resolving (or
    # still queued behind the concurrency limit) when the deadline elapses keeps running in the background,
    # and _resolve_ref_bounded discards its outcome via the `deadline` flag flipped below.
    _done, pending = await asyncio.wait(tasks, timeout=total_timeout_s)
    if pending:
        deadline.exceeded = True
    return resolved


async def _preresolve_initial_data(
    spec: UISpec, deps: McpHostDeps, principal: Principal
) -> tuple[dict[str, TabularData], dict[str, TabularData]]:
    """Preresolve the initial data `{effective ref: TabularData}` co-embedded in the tool result's _meta.

    - Fill each component's initial variant ($ref) across all components first, and fill bind's other variants with the
      remaining budget (initial display has top priority). What exceeds the budget is not co-embedded (partial embedding).
    - Refs are resolved with bounded concurrency (_resolve_refs_bounded, PRERESOLVE_CONCURRENCY workers) subject
      to an overall deadline (PRERESOLVE_TOTAL_TIMEOUT_S), on top of the existing per-ref timeout. The budget
      above is still applied afterward in the fixed initial-then-secondary order, so which refs end up embedded
      on overflow does not depend on completion order.
    - per-ref fail-open: a preresolution failure (or a ref discarded by the overall deadline) skips that ref
      and reports to on_error (compose stays a success).

    Returns `(data, resolved)`: `data` is the existing budget-trimmed `_meta` co-embedding; `resolved` is the
    full pre-budget map, returned so a caller that also needs the same Spec's refs resolved for a second
    purpose (_compose_and_package's legacyUiResource co-emission, via _snapshot_html_for) can reuse this call's
    domain.invoke results instead of resolving the identical ref set a second time.
    """
    initial_refs: list[str] = []
    secondary_refs: list[str] = []
    for component in spec.components:
        if component.data is None:
            continue
        initial = parse_query_ref(component.data.ref).raw
        initial_refs.append(initial)
        for variant in enumerate_bind_variants(component.data):
            if variant != initial:
                secondary_refs.append(variant)

    # Dedup while preserving the initial-then-secondary priority order (the budget loop below walks this same
    # order), so a ref shared by several components/variants is resolved exactly once regardless of concurrency.
    ordered_refs: list[str] = []
    seen_refs: set[str] = set()
    for ref in [*initial_refs, *secondary_refs]:
        if ref in seen_refs:
            continue
        seen_refs.add(ref)
        ordered_refs.append(ref)

    resolved = await _resolve_refs_bounded(
        ordered_refs,
        deps,
        principal,
        timeout_s=PRERESOLVE_TIMEOUT_S,
        total_timeout_s=PRERESOLVE_TOTAL_TIMEOUT_S,
    )

    data: dict[str, TabularData] = {}
    used = 0
    for ref in ordered_refs:
        value = resolved.get(ref)
        if value is None:
            continue  # failed / timed out / unknown source / cut off by the overall deadline
        # Measure the budget (cumulative JSON characters) and, once exceeded, co-embed no more (partial embedding).
        size = len(json.dumps({ref: value.to_wire()}, ensure_ascii=False, separators=(",", ":")))
        if used + size > INITIAL_DATA_BUDGET_CHARS:
            break
        used += size
        data[ref] = value
    return data, resolved
