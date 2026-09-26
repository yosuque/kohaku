"""kohaku.host_core.intent — resolves and finalizes a CanonicalIntent from one of the 3 request shapes that
converge across the compose/event surfaces (port of packages/host-core/src/intent.ts).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from kohaku.spec import (
    GuiAction,
    Intent,
    IntentInput,
    JsonObject,
    NLQuery,
    SemanticInput,
    SessionContext,
    finalize_intent,
)


class _Normalizer(Protocol):
    """The narrow slice of SemanticPort resolve_intent needs (TS: `Pick<SemanticPort, "normalize">`) — callers
    pass `deps.compose.semantic` (a full SemanticPort) as-is; it structurally satisfies this."""

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput: ...


@dataclass(frozen=True)
class IntentSourceIntent:
    """An already-structured Intent, finalized as-is (no semantic.normalize call)."""

    intent: IntentInput
    kind: Literal["intent"] = "intent"


@dataclass(frozen=True)
class IntentSourceNl:
    """A natural-language question, normalized then finalized. `locale` mirrors NLQuery.locale and is
    forwarded to semantic.normalize alongside `session.locale` — per-input locale winning over the session's
    is the SemanticPort implementation's own concern, not this module's."""

    text: str
    locale: str | None = None
    kind: Literal["nl"] = "nl"


@dataclass(frozen=True)
class IntentSourceGui:
    """A GUI event delta, optionally against a `current` Intent (mirrors GuiAction, where `current` is
    likewise optional — a fresh gui action against no prior Intent omits it), normalized then finalized."""

    action: str
    params: JsonObject
    current: Intent | None = None
    kind: Literal["gui"] = "gui"


type IntentSource = IntentSourceIntent | IntentSourceNl | IntentSourceGui
"""The 3 request shapes that resolve into a CanonicalIntent across the compose/event surfaces. Shared by the
REST and MCP profiles wherever a site's choreography matches exactly (REST's /events GUI delta and
/intent/normalize + /compose(/stream) NL/GUI/structured-Intent paths, MCP's compose-tool nl/intent branch)."""


@dataclass(frozen=True)
class ResolvedIntent:
    intent: Intent
    current: Intent | None = None
    """Echoes back the "gui" source's pre-event `current` Intent for the caller's own bookkeeping (e.g.
    /events' recorder.interacted needs the pre-event Intent's hash; callers that already hold `current`
    locally can ignore this field). `None` for the "intent" and "nl" sources."""


async def resolve_intent(
    semantic: _Normalizer, source: IntentSource, session: SessionContext
) -> ResolvedIntent:
    """Resolves and finalizes a CanonicalIntent from one of the 3 `IntentSource` shapes.

    Takes `session` as given — it does not construct or unify SessionContext. The REST and MCP profiles build
    theirs differently (e.g. whether a principal is attached), and this helper must not paper over that.

    "intent" validation: unlike "nl" / "gui", a directly-specified Intent never passes through
    `semantic.normalize`, so when `semantic` has a `validate_intent` method (kohaku.spec.ports'
    `SupportsValidateIntent` -- a genuinely optional `SemanticPort` extension, checked here via `getattr`
    rather than `isinstance` since `typing.Protocol` cannot express an optional member; see that Protocol's
    doc comment) it is called before `finalize_intent` (rejecting an unknown canonical or invalid params
    before a fresh intentHash is ever minted for them). A `semantic` without it keeps the historical behavior
    of finalizing `source.intent` unchecked (backward compatible). Note this only covers callers that route a
    directly-specified Intent through this helper (host_rest's /compose, /events' `current`, and
    /fixations/approve; host_mcp's compose-family tools and `kohaku_event`'s `current`) -- a product calling
    `compose()` directly with a `{kind: "intent"}` ComposeInput bypasses this helper entirely and is therefore
    unvalidated by design (see docs/design.md).
    """
    if isinstance(source, IntentSourceIntent):
        validate_intent = getattr(semantic, "validate_intent", None)
        validated = source.intent if validate_intent is None else await validate_intent(source.intent, session)
        return ResolvedIntent(intent=finalize_intent(validated))
    if isinstance(source, IntentSourceNl):
        normalized = await semantic.normalize(
            NLQuery(kind="nl", text=source.text, locale=source.locale), session
        )
        return ResolvedIntent(intent=finalize_intent(normalized))
    normalized = await semantic.normalize(
        GuiAction(kind="gui", action=source.action, params=source.params, current=source.current),
        session,
    )
    return ResolvedIntent(intent=finalize_intent(normalized), current=source.current)
