"""Shared fixation (L1->L0) delivery + staleness self-healing (port of packages/host-core/src/fixation.ts).

Both host_rest and host_mcp consume this module so the fixation shortcut -> staleness check -> self-heal
(fire-and-forget from the delivery path) -> normal-compose-fallback sequence lives once, the same relationship
host-core has with host-rest/host-mcp-apps in the TS reference implementation (mirroring renderer-core's
relationship to renderer-react/renderer-wc).

The two profiles' scheduling of the self-heal call differs (host_rest awaits it serialized under the
(tenant, intent_hash) fixation lock; host_mcp spawns it as a background asyncio task and does not await
completion), so that strategy — plus failure reporting — is left to the host via
`FixationDeliveryHost.run_self_heal`, exactly preserving each profile's pre-extraction behavior.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from kohaku.composer import (
    ComposeContext,
    ComposeOptions,
    ComposeResult,
    IntentComposeInput,
    compose,
)
from kohaku.composer.fixation import FixationCheck, materialize_fixation
from kohaku.llm import AbortSignal
from kohaku.spec import FixationRecord, Intent, IntentInput, SessionContext


class FixationSelfHealApi(Protocol):
    """Self-healing hooks for fixation staleness detection. kohaku.lineage's Fixations conforms
    structurally as-is (both the REST-profile FixationsApi and the MCP-profile McpFixationsApi are aliases
    of this Protocol).
    """

    async def invalidate(
        self,
        intent_hash: str,
        reason: str,
        detail: str | None = None,
        tenant: str | None = None,
        guard: dict[str, Any] | None = None,
    ) -> None: ...

    async def refresh_fingerprint(
        self, intent_hash: str, catalog_fingerprint: str, tenant: str | None = None
    ) -> None: ...


#: A generic self-heal *kind*, not the wire endpoint string reported to a host's observability hook — the two
#: pre-existing Python profiles use different endpoint-string conventions for the same event
#: (host_rest: "fixation.refresh_fingerprint" / "fixation.invalidate"; host_mcp:
#: "fixation.refreshFingerprint" / "fixation.invalidate"), and preserving each verbatim (zero behavior change)
#: means host_core cannot hardcode one shared string. The host's run_self_heal maps `kind` to its own endpoint
#: string when reporting a failure.
FixationSelfHealKind = Literal["refresh_fingerprint", "invalidate"]

FixationLookup = Callable[[str, SessionContext], Awaitable[FixationRecord | None]]

# Runs one self-heal call: schedules `fn` (however the host chooses — awaited inline under a lock, or spawned as a
# background task), and is responsible for catching `fn`'s failure and reporting it (the host already knows how to
# reach its own observability hook, so host-core does not prescribe a separate on_self_heal_error callback the way
# the TS port does — the host's run_self_heal closure plays that role).
SelfHealRunner = Callable[
    [str | None, str, Callable[[], Awaitable[None]], FixationSelfHealKind], Awaitable[None]
]


@dataclass(frozen=True)
class FixationDeliveryHost:
    """The host-supplied surface settle_fixation / resolve_fixated_result / compose_with_fixation need.

    run_self_heal is required (mirrors the TS port's required onSelfHealError): it decides *how* a self-heal
    call is scheduled (await it now, serialized under a lock, or fire-and-forget via a spawned task) and must
    itself swallow/report `fn`'s failure — host_core only decides *what* to run and *when*.
    """

    run_self_heal: SelfHealRunner
    lookup: FixationLookup | None = None
    fixations: FixationSelfHealApi | None = None


@dataclass(frozen=True)
class FixationTarget:
    """The fixation-delivery target settle_fixation needs, mirroring the TS port's `target` argument shape."""

    intent_hash: str
    tenant: str | None
    catalog_fingerprint: str
    fixation: FixationRecord


@dataclass(frozen=True)
class ComposeFixationContext:
    """ctx for compose_with_fixation. `compose` (the ComposeContext for the normal-compose fallback) defaults to
    `materialize` when omitted — the MCP profile has a single ComposeContext to begin with; the REST profile
    passes its untenanted deps.compose here since compose() re-applies tenant/session internally.
    """

    materialize: ComposeContext
    compose: ComposeContext | None = None
    abort: AbortSignal | None = None


async def settle_fixation(
    materialized: tuple[ComposeResult | None, FixationCheck],
    target: FixationTarget,
    host: FixationDeliveryHost,
) -> ComposeResult | None:
    """Takes materialize_fixation's staleness-check result, decides whether delivery is allowed, and fires
    self-healing as a side effect. lineage recording cannot be done in the composer (dependency
    direction), so it is done here in host_core, shared by both host profiles.

    - revalidated: re-stamp the current catalog fingerprint (fast-path next time). Delivery is not stopped even
      on failure — the self-heal call's failure only reaches the host's run_self_heal reporting.
    - stale: invalidate the fixation and return None = the caller falls back to normal compose. Even if
      invalidate raises, delivery continues (the fixation remains and runs degraded: revalidation fails every
      time -> fallback).
    """
    result, check = materialized
    fixations = host.fixations

    if result is not None:
        if check.kind == "revalidated" and fixations is not None:

            async def _refresh() -> None:
                await fixations.refresh_fingerprint(
                    target.intent_hash, target.catalog_fingerprint, target.tenant
                )

            await host.run_self_heal(
                target.tenant, target.intent_hash, _refresh, "refresh_fingerprint"
            )
        return result

    # stale: not deliverable. Invalidate the fixation as self-healing (delivery continues via fallback).
    detail = "; ".join(check.issues) if check.kind == "stale" and check.issues else None
    if fixations is not None:
        # TOCTOU guard: prefer the finer-grained revision token when the judged fixation carries one (D7;
        # distinguishes a same-millisecond unfixate->fixate pair, unlike fixatedAt's ms-precision timestamp),
        # falling back to fixatedAt for records that predate it (protects even a legacy record with no
        # catalogFingerprint), plus the catalog fingerprint when the fixation has one, so a different fixation
        # re-approved after the judgment is not deleted by mistake.
        guard: dict[str, Any] = (
            {"ifRevision": target.fixation.revision}
            if target.fixation.revision is not None
            else {"ifFixatedAt": target.fixation.fixatedAt}
        )
        if target.fixation.catalogFingerprint is not None:
            guard["ifCatalogFingerprint"] = target.fixation.catalogFingerprint

        async def _invalidate() -> None:
            await fixations.invalidate(
                target.intent_hash, "stale", detail, target.tenant, guard
            )

        await host.run_self_heal(target.tenant, target.intent_hash, _invalidate, "invalidate")
    return None


async def resolve_fixated_result(
    intent: Intent,
    session: SessionContext,
    ctx: ComposeContext,
    host: FixationDeliveryHost,
) -> ComposeResult | None:
    """Resolves the L0 fixation shortcut. Assembling the fixated Spec/trace is centralized in
    composer.materialize_fixation (avoiding duplicating the normative logic). No fixation / stale (self-healing
    fired by settle_fixation) returns None, and the caller falls back to normal compose / streaming generation.
    """
    fixation = await host.lookup(intent.hash, session) if host.lookup is not None else None
    if fixation is None:
        return None
    materialized = await materialize_fixation(fixation, intent, ctx, session.tenant)
    return await settle_fixation(
        materialized,
        FixationTarget(
            intent_hash=intent.hash,
            tenant=session.tenant,
            catalog_fingerprint=ctx.catalog.fingerprint,
            fixation=fixation,
        ),
        host,
    )


async def compose_with_fixation(
    intent: Intent,
    session: SessionContext,
    ctx: ComposeFixationContext,
    host: FixationDeliveryHost,
) -> ComposeResult:
    """Fixation shortcut -> normal compose."""
    settled = await resolve_fixated_result(intent, session, ctx.materialize, host)
    if settled is not None:
        return settled
    return await compose(
        IntentComposeInput(intent=IntentInput(canonical=intent.canonical, params=intent.params)),
        ctx.compose if ctx.compose is not None else ctx.materialize,
        ComposeOptions(session=session, abort=ctx.abort),
    )
