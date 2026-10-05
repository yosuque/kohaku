"""Shared failure-path observability building blocks (port of packages/host-core/src/errors.ts)."""

from __future__ import annotations

import asyncio
import inspect
import sys
import traceback
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from kohaku.composer import ComposeError, ComposeErrorContext
from kohaku.llm import LlmError
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

    The "any exception with a string `code`" rule is deliberately a general rule with a deny-list of exactly
    one entry: `LlmError` (kohaku.llm) carries a string `code` too, but its message is the provider SDK's own
    wording (e.g. "Anthropic API key is missing. Pass it using ..."), an operator-side misconfiguration detail
    that must not be shown to a client. The rule is not narrowed further because the governance, intent and
    binding errors named above rely on it. The class-name check is a duck-typed twin of the isinstance check
    so a duplicate install of kohaku.llm is still excluded.
    """
    if _is_llm_error(e):
        return False
    if isinstance(e, (SpecError, ComposeError, QueryRefError)):
        return True
    return isinstance(e, BaseException) and isinstance(getattr(e, "code", None), str)


def _is_llm_error(e: object) -> bool:
    return isinstance(e, LlmError) or (isinstance(e, BaseException) and type(e).__name__ == "LlmError")


LLM_PROVIDER_UNAVAILABLE_MESSAGE = "LLM provider unavailable; see the host's observability hook (onError) for details"
"""The fixed, client-safe message for a failure caused by the LLM provider being unavailable (API key not
configured, provider error or timeout, aborted call) while a host operation that cannot degrade without an LLM
(Intent resolution) was running. The detail goes to the observability hook (`on_error`); the envelope's request
id correlates the two. Identical to TS host-core's LLM_PROVIDER_UNAVAILABLE_MESSAGE."""


def is_llm_unavailable_error(e: object) -> bool:
    """True when `e` is an `LlmError` whose code says the provider itself could not serve the call: PROVIDER
    (the call failed), CONFIG (no key / unknown provider) or ABORTED (timeout / cancellation). INVALID_OUTPUT
    (the model answered, but not in the expected shape) is deliberately not included: that is a per-input
    failure, not an unavailable upstream. Port of TS host-core's isLlmUnavailableError (errors.ts).
    """
    if not _is_llm_error(e):
        return False
    return getattr(e, "code", None) in ("PROVIDER", "CONFIG", "ABORTED")


@dataclass(frozen=True)
class HostErrorClass:
    """What a host should do with a caught exception: map to 503 (`upstream_unavailable`), pass its message
    through (`typed`), or use a fixed fallback (`untyped`). `message` is set for the first two kinds. Port of
    TS host-core's HostErrorClass (errors.ts)."""

    kind: Literal["upstream_unavailable", "typed", "untyped"]
    message: str | None = None


def classify_host_error(e: object) -> HostErrorClass:
    """Classifies a caught exception for a client-facing failure response. Shared by both host profiles so
    REST's 503 and MCP's tool error agree on which failures are "the upstream LLM is unavailable". Port of TS
    host-core's classifyHostError (errors.ts)."""
    if is_llm_unavailable_error(e):
        return HostErrorClass("upstream_unavailable", LLM_PROVIDER_UNAVAILABLE_MESSAGE)
    if is_typed_host_error(e):
        return HostErrorClass("typed", str(e))
    return HostErrorClass("untyped")


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


# Strong references to in-flight fire-and-forget hook tasks (an asyncio task with no other reference can be
# garbage-collected mid-flight); each task removes itself when done.
_pending_hook_tasks: set[asyncio.Future[None]] = set()


def notify_hook_nowait[I](hook: Callable[[I], object] | None, info: I) -> None:
    """Fire-and-forget counterpart of `notify_hook`: invokes the hook immediately (a synchronous hook has run
    by the time this returns) but never awaits an awaitable result -- that is scheduled on the running event
    loop, so a slow or hung async observer cannot delay the caller. A failure of the hook (a synchronous raise
    or an awaited failure) is swallowed, as in `notify_hook`. Port of TS host-core's `void notifyHook(...)`
    call convention for hooks documented as fire-and-forget (e.g. the rate limiter's `onError`).
    """
    if hook is None:
        return
    try:
        result = hook(info)
    except Exception:
        return  # A failure of the observation-only hook must not propagate.
    if not inspect.isawaitable(result):
        return

    async def _drain() -> None:
        try:
            await result
        except Exception:
            pass  # A failure of the observation-only hook must not propagate.

    task = asyncio.ensure_future(_drain())
    _pending_hook_tasks.add(task)
    task.add_done_callback(_pending_hook_tasks.discard)


async def fail_open(
    fn: Callable[[], Awaitable[None]],
    on_failure: Callable[[BaseException], Awaitable[None]],
) -> None:
    """Runs `fn`, and on failure runs `on_failure(error)` instead of re-raising. Shared building block for
    fail-open audit recording (REST's safe_record / MCP's on_composed fail-open wrapper): prioritizes delivery
    availability by swallowing a recording failure rather than letting it take down an otherwise-successful
    response. Catches `Exception` only: a `BaseException` such as `asyncio.CancelledError` must keep
    propagating, or a cancelled recording would be swallowed and the caller would carry on (e.g. into
    `domain.invoke`) as if the request were still live.
    """
    try:
        await fn()
    except Exception as e:
        await on_failure(e)


_DEFAULT_MAX_CHAIN_DEPTH = 10


def format_error_chain(err: object, max_depth: int = _DEFAULT_MAX_CHAIN_DEPTH) -> str:
    """Formats `err`'s full `__cause__` chain (Python's exception-chaining convention -- the equivalent of
    TS's ES2022 `Error.cause`) as a single log-friendly line: "Type: message" for `err` itself, then for each
    exception it is caused by, joined by " <- " so the immediate failure reads first and its root cause last.
    A non-exception value is rendered with `str()` and ends the walk there (it has no `__cause__` of its own
    to keep following) -- in practice this can only be `err` itself (a caller may pass a plain reason string
    instead of an actual exception; see ComposeObserver.onError's `error` argument), never a link partway
    through the chain, since Python enforces `__cause__` to be `None` or a `BaseException` (unlike TS's
    untyped `Error.cause`). Stops after `max_depth` links regardless of whether the chain is actually
    exhausted, so a circular or unexpectedly long `__cause__` chain can never make this loop forever or
    produce an unbounded string. Port of TS host-core's formatErrorChain (errors.ts).
    """
    segments: list[str] = []
    current: object = err
    depth = 0
    while depth < max_depth and current is not None:
        if not isinstance(current, BaseException):
            segments.append(str(current))
            break
        segments.append(f"{type(current).__name__}: {current}")
        current = current.__cause__
        depth += 1
    return " <- ".join(segments)


class _HostErrorInfoLike(Protocol):
    """Structural shape matching `kohaku.host_rest.deps.HostErrorInfo`'s `(endpoint, request_id, error)`
    without host_core importing it (the dependency direction fixed by AGENTS.md is host_rest -> host_core).
    Mirrors TS host-core's inline `{ endpoint, requestId, error }` object type in
    createConsoleErrorReporter (errors.ts). Scoped to host-rest only -- `kohaku.host_mcp`'s `McpErrorInfo`
    has no `request_id` (see its own docstring), so `create_console_error_reporter`'s `host` handler is not
    meant to be passed as MCP's `on_error`.
    """

    # Read-only properties (rather than plain attributes) so a frozen dataclass such as
    # kohaku.host_rest.deps.HostErrorInfo satisfies this Protocol structurally -- a plain attribute
    # declaration would require a *settable* attribute, which a frozen dataclass field is not.
    @property
    def endpoint(self) -> str: ...
    @property
    def request_id(self) -> str: ...
    @property
    def error(self) -> object: ...


@dataclass(frozen=True)
class ConsoleErrorReporterOptions:
    """Options for `create_console_error_reporter`."""

    debug: bool = False
    """Verbose mode: each logged line becomes the full `cause` chain (format_error_chain) plus the top
    error's traceback, instead of a one-line "prefix: message" summary. Default False. This function never
    reads an environment variable itself (e.g. KOHAKU_DEBUG) -- resolving `debug` from one is the caller's
    job (see examples/sales-api's wiring), which keeps this function usable outside a Node/env-var-shaped
    environment too."""
    log: Callable[[str], None] | None = None
    """Where to write each formatted line. Default: print to stderr. Injectable for tests or a custom log sink."""


@dataclass(frozen=True)
class ConsoleErrorReporter:
    """A pair of handlers pre-wired to `KohakuHostDeps.on_error`'s exact signature (host-rest) and
    `ComposeObserver.onError`'s exact signature (composer). Port of TS host-core's ConsoleErrorReporter
    (errors.ts)."""

    host: Callable[[_HostErrorInfoLike], None]
    """Matches `KohakuHostDeps.on_error` (host-rest) verbatim -- pass as `on_error` directly."""
    compose: Callable[[ComposeErrorContext, BaseException | None], None]
    """Matches `ComposeObserver.onError` (composer) verbatim -- pass as `ComposeObserver(onError=...)` directly."""


def create_console_error_reporter(
    options: ConsoleErrorReporterOptions | None = None,
) -> ConsoleErrorReporter:
    """Builds a pair of stderr-logging handlers pre-wired to `KohakuHostDeps.on_error`'s exact signature
    (host-rest) and `ComposeObserver.onError`'s exact signature (composer) -- the smallest reasonable
    default for a demo host that has not wired its own logging/metrics yet. A product with real
    observability infrastructure should supply its own hooks instead; this exists so "what actually went
    wrong" is visible on stderr out of the box rather than only inferable from an HTTP 500. Port of TS
    host-core's createConsoleErrorReporter (errors.ts).
    """
    opts = options if options is not None else ConsoleErrorReporterOptions()
    debug = opts.debug
    log = opts.log if opts.log is not None else lambda line: print(line, file=sys.stderr)

    def _write_line(prefix: str, error: object) -> None:
        if not debug:
            log(f"{prefix}: {error}")
            return
        lines = [f"{prefix}: {format_error_chain(error)}"]
        if isinstance(error, BaseException):
            rendered = "".join(traceback.format_exception(error)).rstrip("\n")
            if rendered != "":
                lines.append(rendered)
        log("\n".join(lines))

    def _host(info: _HostErrorInfoLike) -> None:
        _write_line(f"[kohaku] {info.endpoint} (request {info.request_id})", info.error)

    def _compose(ctx: ComposeErrorContext, error: BaseException | None) -> None:
        # A "fallback"/"cancelled" phase carries no raised exception (error is None for most failure kinds)
        # -- the failure is described by ctx.reason instead. "hard"/"cache" always carry the causing
        # exception in `error`. See ComposeErrorContext's own doc for the full phase/field contract.
        detail: object = error if error is not None else (ctx.reason if ctx.reason is not None else "unknown failure")
        # Tier and intent are what let an operator tell which generation this line is about. (Unlike the TS
        # port, Python's ComposeErrorContext carries no correlation id, so none is printed.)
        parts = [
            f"tier {ctx.tier}" if ctx.tier is not None else None,
            f"intent {ctx.intent.canonical}" if ctx.intent is not None else None,
        ]
        details = [part for part in parts if part is not None]
        suffix = f" ({', '.join(details)})" if details else ""
        _write_line(f"[kohaku] compose {ctx.phase}{suffix}", detail)

    return ConsoleErrorReporter(host=_host, compose=_compose)
