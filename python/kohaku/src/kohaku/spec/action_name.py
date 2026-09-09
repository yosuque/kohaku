"""Rule for resolving the action name a write event invokes (port of TS action-name.ts — the single source of truth)."""

from __future__ import annotations

from .models import JsonObject, UISpec


def resolve_write_action_name(props: JsonObject | None, payload: JsonObject) -> str | None:
    """Resolve the action name for emit=="action.invoke".

    Prefer the target component's props.action (presentForm); otherwise the event payload's action
    (action.button). If neither exists, None (the renderer falls back to forwarding, and the host issues no
    write scope). If action resolution drifts between authorization and execution, writes silently 403, so
    the rule is not duplicated.
    """
    from_props = props.get("action") if props is not None else None
    if isinstance(from_props, str) and len(from_props) > 0:
        return from_props
    from_payload = payload.get("action")
    if isinstance(from_payload, str) and len(from_payload) > 0:
        return from_payload
    return None


def collect_write_actions(spec: UISpec) -> list[str]:
    """Collect the target action names of writes (emit=="action.invoke") from a Spec's events.

    Symmetric to read covering "references the UI reads", this covers "writes the UI declared". Both the
    REST and MCP surfaces consume it so the write-capability issuance rule matches across both profiles.
    """
    by_id = {c.id: c for c in spec.components}
    actions: dict[str, None] = {}
    for e in spec.events:
        if e.emit != "action.invoke":
            continue
        node = by_id.get(e.on.split(".")[0] if e.on else "")
        action = resolve_write_action_name(node.props if node is not None else None, e.payload)
        if action is not None:
            actions[action] = None
    return list(actions.keys())
