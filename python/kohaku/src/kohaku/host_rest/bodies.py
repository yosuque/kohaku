"""Request body validation / parsing (port of the zod schemas in TS routes.ts).

TS uses zod; Python reproduces the same accept/reject boundary with defensive procedural validation. On parse
failure it returns None, and the caller maps it to 400 BAD_REQUEST.

Promotion actions / ComponentDraft are built and returned as kohaku.lineage value types. Python's promotion state
machine branches with `isinstance(action, Nominate)`, etc. (unlike TS's plain objects + `.kind` branching), so the
host must pass concrete PromotionAction / ComponentDraft (an intentional difference from TS's decoupling; the service
surface Promotions / Fixations stays a structural Protocol and only imports the shared vocabulary).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from kohaku.lineage import (
    ComponentDraft,
    JudgeResult,
    JudgeStart,
    Nominate,
    PromotionAction,
    Publish,
    QueryTemplate,
    ReviewApprove,
    ReviewReject,
    ReviewRequestChanges,
    ReviewStart,
    SchemaPropose,
    Unpublish,
    Withdraw,
)
from kohaku.spec import GuiAction, Intent, IntentInput, NLQuery, Principal

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _as_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_nonempty_str(value: Any) -> str | None:
    return value if isinstance(value, str) and len(value) > 0 else None


def _as_bounded_str(value: Any, max_len: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= max_len else None


# Upper bound on a JsonObject's nesting depth (the object itself = depth 1). Mirrors
# packages/spec-core/src/schema/json.ts's JsonObjectSchema depth cap: guards the recursive canonical-JSON
# serialization (cache-key / spec-hash computation) and lineage persistence downstream of request bodies
# (params / payload fields) against a pathologically deep but otherwise well-formed JSON payload.
MAX_JSON_OBJECT_DEPTH = 32

# Upper bound (characters) on a client-supplied sessionId. Mirrors TS routes/schemas.ts's SessionSchema
# sessionId.max(128): bounds a client-controlled string flowing into lineage records / recorder keys.
MAX_SESSION_ID_LEN = 128

# Upper bound (characters) on client-supplied surface/renderer/locale strings. Mirrors TS routes/schemas.ts's
# SessionSchema.surface/.locale and TelemetryBodySchema.surface/.renderer, all .max(64): same rationale as
# MAX_SESSION_ID_LEN above -- these flow into lineage records / recorder keys too.
MAX_SHORT_STRING_LEN = 64

# Upper bound (characters) on a client-supplied specHash/artifactId. Mirrors TS routes/schemas.ts's
# TelemetryBodySchema.specHash/.artifactId, both .max(128).
MAX_HASH_ID_LEN = 128


def _json_depth_ok(value: Any, limit: int = MAX_JSON_OBJECT_DEPTH, depth: int = 1) -> bool:
    """True while `value`'s nesting stays within `limit` (the object/array itself = depth 1). Only
    descending into a dict/list counts toward depth — a scalar leaf never does, since it cannot nest any
    further. Mirrors spec-core/schema/json.ts's exceedsMaxJsonDepth (inverted: True = not exceeded)."""
    if isinstance(value, dict):
        if depth > limit:
            return False
        return all(_json_depth_ok(v, limit, depth + 1) for v in value.values())
    if isinstance(value, list):
        if depth > limit:
            return False
        return all(_json_depth_ok(v, limit, depth + 1) for v in value)
    return True


def _as_json_object(value: Any) -> dict[str, Any] | None:
    """A JsonObject: a dict whose nesting depth stays within MAX_JSON_OBJECT_DEPTH. None (reject) if not a
    dict or too deeply nested. Use this (rather than bare _as_dict) for any params/payload field that flows
    into canonicalStringify / lineage persistence downstream."""
    data = _as_dict(value)
    if data is None or not _json_depth_ok(data):
        return None
    return data


# ---------------------------------------------------------------------------
# Shared: compose / intent/normalize / events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionBody:
    surface: str = "web"
    session_id: str | None = None
    locale: str | None = None
    """Optional locale tag ("en" / "ja"). Threaded to SessionContext.locale so hosts can vary
    NL normalization hints and (product policy permitting) generation output language."""


@dataclass(frozen=True)
class ComposeBody:
    input: NLQuery | GuiAction | None
    intent: IntentInput | None
    session: SessionBody


@dataclass(frozen=True)
class EventBody:
    on: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class EventsBody:
    intent: IntentInput
    event: EventBody
    session: SessionBody


def parse_session(raw: Any) -> SessionBody | None:
    """Validate session. Unspecified defaults to {surface:"web"}. Fails (None) if not a dict."""
    if raw is None:
        return SessionBody()
    data = _as_dict(raw)
    if data is None:
        return None
    surface_raw = data.get("surface", "web")
    surface = _as_bounded_str(surface_raw, MAX_SHORT_STRING_LEN)
    if surface is None:
        return None
    session_id = data.get("sessionId")
    if session_id is not None and (
        not isinstance(session_id, str) or len(session_id) > MAX_SESSION_ID_LEN
    ):
        return None
    locale = data.get("locale")
    if locale is not None and _as_bounded_str(locale, MAX_SHORT_STRING_LEN) is None:
        return None
    return SessionBody(surface=surface, session_id=session_id, locale=locale)


def parse_semantic_input(raw: Any) -> NLQuery | GuiAction | None:
    """Validate and build a SemanticInput (NLQuery | GuiAction). None if invalid."""
    data = _as_dict(raw)
    if data is None:
        return None
    kind = data.get("kind")
    if kind == "nl":
        text = _as_nonempty_str(data.get("text"))
        if text is None:
            return None
        locale = data.get("locale")
        if locale is not None and not isinstance(locale, str):
            return None
        return NLQuery(kind="nl", text=text, locale=locale)
    if kind == "gui":
        action = _as_nonempty_str(data.get("action"))
        params = _as_json_object(data.get("params"))
        if action is None or params is None:
            return None
        current_raw = data.get("current")
        current: Intent | None = None
        if current_raw is not None:
            current_dict = _as_dict(current_raw)
            if current_dict is None:
                return None
            if not _json_depth_ok(current_dict.get("params", {})):
                return None
            try:
                current = Intent.model_validate(current_dict)
            except Exception:
                return None
        return GuiAction(kind="gui", action=action, params=params, current=current)
    return None


def _parse_intent(raw: Any) -> IntentInput | None:
    data = _as_dict(raw)
    if data is None:
        return None
    canonical = _as_str(data.get("canonical"))
    params = _as_json_object(data.get("params"))
    if canonical is None or params is None:
        return None
    return IntentInput(canonical=canonical, params=params)


def parse_compose_body(data: Any) -> ComposeBody | None:
    """Body for POST /compose, /intent/normalize, and /fixations/approve. Fails if not a dict."""
    body = _as_dict(data)
    if body is None:
        return None
    session = parse_session(body.get("session"))
    if session is None:
        return None
    input_value: NLQuery | GuiAction | None = None
    if "input" in body and body["input"] is not None:
        input_value = parse_semantic_input(body["input"])
        if input_value is None:
            return None
    intent_value: IntentInput | None = None
    if "intent" in body and body["intent"] is not None:
        intent_value = _parse_intent(body["intent"])
        if intent_value is None:
            return None
    return ComposeBody(input=input_value, intent=intent_value, session=session)


def parse_events_body(data: Any) -> EventsBody | None:
    """Body for POST /events. intent and event are required."""
    body = _as_dict(data)
    if body is None:
        return None
    intent_value = _parse_intent(body.get("intent"))
    if intent_value is None:
        return None
    event_raw = _as_dict(body.get("event"))
    if event_raw is None:
        return None
    on = _as_nonempty_str(event_raw.get("on"))
    if on is None:
        return None
    payload_raw = event_raw.get("payload", {})
    payload = _as_json_object(payload_raw)
    if payload is None:
        return None
    session = parse_session(body.get("session"))
    if session is None:
        return None
    return EventsBody(
        intent=intent_value, event=EventBody(on=on, payload=payload), session=session
    )


# ---------------------------------------------------------------------------
# binding/action
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ActionBody:
    action: str
    payload: dict[str, Any] | None


def parse_action_body(data: Any) -> ActionBody | None:
    """Equivalent to ActionBodySchema. payload must be a JSON object (an array/string/etc. is rejected with
    400): DomainPort.invoke's `args` contract is an object of named params, and passing anything else through
    would misrepresent it as one."""
    body = _as_dict(data)
    if body is None:
        return None
    action = _as_nonempty_str(body.get("action"))
    if action is None:
        return None
    if "payload" in body and body["payload"] is not None:
        payload = _as_json_object(body["payload"])
        if payload is None:
            return None
    else:
        payload = None
    return ActionBody(action=action, payload=payload)


# ---------------------------------------------------------------------------
# telemetry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RenderedEvent:
    specHash: str
    surface: str | None
    renderer: str | None
    durationMs: float | None


@dataclass(frozen=True)
class ComponentUsedEvent:
    artifactId: str
    surface: str | None
    outcome: str | None
    sessionId: str | None


TelemetryEvent = RenderedEvent | ComponentUsedEvent


def parse_telemetry_body(data: Any) -> list[TelemetryEvent] | None:
    """Body for POST /telemetry. An events array (max 500 per batch)."""
    body = _as_dict(data)
    if body is None:
        return None
    events_raw = body.get("events")
    if not isinstance(events_raw, list) or len(events_raw) > 500:
        return None
    events: list[TelemetryEvent] = []
    for raw in events_raw:
        item = _as_dict(raw)
        if item is None:
            return None
        kind = item.get("kind")
        if kind == "rendered":
            spec_hash = _as_bounded_str(item.get("specHash"), MAX_HASH_ID_LEN)
            if spec_hash is None:
                return None
            surface_raw = item.get("surface")
            if surface_raw is not None and _as_bounded_str(surface_raw, MAX_SHORT_STRING_LEN) is None:
                return None
            renderer_raw = item.get("renderer")
            if renderer_raw is not None and _as_bounded_str(renderer_raw, MAX_SHORT_STRING_LEN) is None:
                return None
            duration = item.get("durationMs")
            if duration is not None and not isinstance(duration, int | float):
                return None
            events.append(
                RenderedEvent(
                    specHash=spec_hash,
                    surface=surface_raw,
                    renderer=renderer_raw,
                    durationMs=float(duration) if duration is not None else None,
                )
            )
        elif kind == "componentUsed":
            artifact_id = _as_bounded_str(item.get("artifactId"), MAX_HASH_ID_LEN)
            if artifact_id is None:
                return None
            surface_raw = item.get("surface")
            if surface_raw is not None and _as_bounded_str(surface_raw, MAX_SHORT_STRING_LEN) is None:
                return None
            outcome = item.get("outcome")
            if outcome is not None and outcome not in ("ok", "error"):
                return None
            events.append(
                ComponentUsedEvent(
                    artifactId=artifact_id,
                    surface=surface_raw,
                    outcome=outcome,
                    sessionId=_as_str(item.get("sessionId")),
                )
            )
        else:
            return None
    return events


# ---------------------------------------------------------------------------
# Promotion ComponentDraft / PromotionAction
# ---------------------------------------------------------------------------


def parse_component_draft(raw: Any) -> ComponentDraft | None:
    """Equivalent to ComponentDraftSchema. componentType / version / intentName / description are required."""
    data = _as_dict(raw)
    if data is None:
        return None
    component_type = _as_nonempty_str(data.get("componentType"))
    version = _as_nonempty_str(data.get("version"))
    intent_name = _as_nonempty_str(data.get("intentName"))
    description = _as_nonempty_str(data.get("description"))
    if component_type is None or version is None or intent_name is None or description is None:
        return None
    query_template: QueryTemplate | None = None
    if "queryTemplate" in data and data["queryTemplate"] is not None:
        qt = _as_dict(data["queryTemplate"])
        if qt is None:
            return None
        path = _as_nonempty_str(qt.get("path"))
        if path is None:
            return None
        fixed_params = qt.get("fixedParams")
        param_map = qt.get("paramMap")
        if fixed_params is not None and not isinstance(fixed_params, dict):
            return None
        if param_map is not None and not isinstance(param_map, dict):
            return None
        query_template = QueryTemplate(
            path=path, fixedParams=fixed_params, paramMap=param_map
        )
    return ComponentDraft(
        componentType=component_type,
        version=version,
        intentName=intent_name,
        description=description,
        paramsJsonSchema=data.get("paramsJsonSchema"),
        queryTemplate=query_template,
    )


def parse_promotion_action(raw: Any, principal: Principal) -> PromotionAction | None:
    """Equivalent to PromotionActionSchema. Builds a PromotionAction, injecting the server-side principal.

    nominate injects the session principal into `by`, and review.* into `reviewer` (a client-declared value is not accepted).
    """
    data = _as_dict(raw)
    if data is None:
        return None
    kind = data.get("kind")
    if kind == "nominate":
        return Nominate(by=principal)
    if kind == "judge.start":
        return JudgeStart()
    if kind == "judge.result":
        verdict = _as_dict(data.get("verdict"))
        if verdict is None:
            return None
        if not isinstance(verdict.get("pass"), bool) or not isinstance(
            verdict.get("score"), int | float
        ):
            return None
        return JudgeResult(verdict={"pass": verdict["pass"], "score": verdict["score"]})
    if kind == "review.start":
        return ReviewStart()
    if kind == "review.approve":
        return ReviewApprove(reviewer=principal, comment=_as_str(data.get("comment")))
    if kind == "review.requestChanges":
        return ReviewRequestChanges(reviewer=principal, comment=_as_str(data.get("comment")))
    if kind == "review.reject":
        return ReviewReject(reviewer=principal, comment=_as_str(data.get("comment")))
    if kind == "schema.propose":
        draft = parse_component_draft(data.get("draft"))
        if draft is None:
            return None
        return SchemaPropose(draft=draft)
    if kind == "publish":
        version = _as_nonempty_str(data.get("version"))
        if version is None:
            return None
        return Publish(version=version)
    if kind == "withdraw":
        return Withdraw(reason=_as_str(data.get("reason")))
    if kind == "unpublish":
        return Unpublish(reason=_as_str(data.get("reason")))
    return None
