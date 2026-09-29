"""kohaku.host_core.action_manifest — builds the wire-shaped Action manifest for a composed Spec (port of
packages/host-core/src/action-manifest.ts).
"""

from __future__ import annotations

from dataclasses import dataclass

from kohaku.spec import ActionTier, JsonValue, UISpec, collect_write_actions

from .operation_index import OperationIndexEntry


@dataclass(frozen=True)
class ActionManifestEntry:
    """One entry of an `ActionManifest` (design.md #64: the wire shape of `actions[name]`)."""

    tier: ActionTier
    paramsSchema: JsonValue | None = None
    """The action's raw params schema (the same value OperationDescriptor.paramsSchema declared), when present."""
    confirmMessage: str | None = None


ActionManifest = dict[str, ActionManifestEntry]
"""`{actionName: ActionManifestEntry}`, keyed by exactly the write actions the Spec declares
(`collect_write_actions`, SPEC §5 A1) -- the same set a capability's write scopes are issued for. Carried
alongside a compose response, not inside the UISpec itself (design.md #64: an Action manifest lives outside
the Spec, next to the capability), so it never affects specHash / the cache key."""


def build_action_manifest(
    spec: UISpec, index: dict[str, OperationIndexEntry]
) -> ActionManifest | None:
    """Builds the ActionManifest for `spec`, given the domain's OperationIndex (already resolved via
    `create_operation_index`). An action the Spec declares but that is not a real DomainPort operation is
    silently omitted (the same fail-open drop `_filter_allowed_scopes`/`WriteScopeDroppedError` already apply
    to capability issuance for the same reason: a hallucinated/injected action.invoke action name must not
    surface as if it were a governed, known action).

    Returns None (never an empty dict) when the Spec declares no write actions, or when every declared action
    was dropped, so this stays purely additive to the wire shape on the common case (a read-only Spec).
    """
    actions = collect_write_actions(spec)
    if not actions:
        return None

    manifest: ActionManifest = {}
    for action in actions:
        entry = index.get(action)
        # A declared operation whose paramsSchema failed validation is omitted too: it cannot be invoked.
        if entry is None or entry.schema_error is not None:
            continue
        manifest[action] = ActionManifestEntry(
            tier=entry.descriptor.tier if entry.descriptor.tier is not None else "auto",
            paramsSchema=entry.params_schema,  # type: ignore[arg-type]  # ActionParamsSchema is a JsonValue-shaped dict
            confirmMessage=entry.descriptor.confirmMessage,
        )
    return manifest if manifest else None


__all__ = ["ActionManifest", "ActionManifestEntry", "build_action_manifest"]
