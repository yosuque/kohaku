"""kohaku.host_core.action_effects — shapes the post-write response for the write-through path (port of
packages/host-core/src/action-effects.ts).
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Protocol, TypedDict

from kohaku.spec import JsonObject


class ActionEffectsResult(Protocol):
    """Structural shape an `ActionEffectsHook` resolves to. REST's and MCP's own `ActionEffects` dataclasses
    (host_rest.deps.ActionEffects / host_mcp.server.ActionEffects) both satisfy this without host_core
    importing either — host_core must not depend on host_rest or host_mcp. Declared as read-only properties
    (rather than plain attributes) so a `@dataclass(frozen=True)` implementation — both real ones are frozen —
    still structurally matches (a Protocol's plain attributes are otherwise read-write, which a frozen
    dataclass's read-only fields do not satisfy).
    """

    @property
    def invalidates(self) -> list[str] | None: ...
    @property
    def refVersions(self) -> dict[str, str] | None: ...


ActionEffectsHook = Callable[[str, JsonObject, object], Awaitable[ActionEffectsResult]]
"""Optional side-effect declaration a host wires for its write-through path (REST's /binding/action, MCP's
`${prefix}_action`)."""


class ActionEffectsResponse(TypedDict, total=False):
    """The post-write response body (REST's /binding/action JSON body, MCP's `${prefix}_action`
    structured_content). `invalidates` / `refVersions` are present only when the actionEffects hook supplied
    them — omitted (not present with a null/empty value) when absent, to keep the wire shape backward
    compatible with a host that never wires actionEffects."""

    result: object
    invalidates: list[str]
    refVersions: dict[str, str]


async def apply_action_effects(
    action_effects: ActionEffectsHook | None,
    action: str,
    payload: JsonObject,
    result: object,
    on_effects_error: Callable[[BaseException], Awaitable[None] | None],
) -> ActionEffectsResponse:
    """Shapes the post-write response for the write-through path (REST's /binding/action, MCP's
    `${prefix}_action`). The write (domain.invoke) is already committed by the time this runs, which is why
    this is fail-open: the side-effect declaration (action_effects) is a "declaration", not the write itself,
    so turning its failure into a client-visible error would make the client resend and could duplicate a
    non-idempotent write. An action_effects failure is therefore reported via on_effects_error and swallowed
    (never re-raised), and the response still succeeds with `{result}` only (the backward-compatible shape
    both hosts' clients already parse).
    """
    effects: ActionEffectsResult | None = None
    if action_effects is not None:
        try:
            effects = await action_effects(action, payload, result)
        except BaseException as e:  # noqa: BLE001 — reported via on_effects_error, never re-raised (fail-open)
            maybe = on_effects_error(e)
            if inspect.isawaitable(maybe):
                await maybe
    response: ActionEffectsResponse = {"result": result}
    if effects is not None and effects.invalidates is not None:
        response["invalidates"] = effects.invalidates
    if effects is not None and effects.refVersions is not None:
        response["refVersions"] = effects.refVersions
    return response
