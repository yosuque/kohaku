"""Side-effect declaration for writes (annotate) (port of TS: apps/sample-api/src/action-effects.ts).

Shared by the REST side (/binding/action) and the MCP side (kohaku_action). Because annotate advances the data
version, it invalidates the displayed references indicated by payload.refs with the new version (a distant table
re-resolves in place and does not go STALE). Actions not targeted have no side effects.
"""

from __future__ import annotations

from dataclasses import dataclass

from kohaku.spec import JsonObject, TabularData


@dataclass(frozen=True)
class ActionEffect:
    """An action's side effect (equivalent to TS's `{ invalidates?; refVersions? }`)."""

    invalidates: list[str] | None = None
    refVersions: dict[str, str] | None = None


async def sales_action_effects(action: str, payload: JsonObject, result: object) -> ActionEffect:
    if action != "annotate":
        return ActionEffect()
    refs = _extract_refs(payload)
    data_version = _data_version_of(result)
    if len(refs) == 0 or data_version is None:
        return ActionEffect(invalidates=refs)
    return ActionEffect(invalidates=refs, refVersions={r: data_version for r in refs})


def _extract_refs(payload: JsonObject) -> list[str]:
    """Safely extracts the query:// URIs to invalidate (payload.refs) from the write payload."""
    refs = payload.get("refs")
    if not isinstance(refs, list):
        return []
    return [r for r in refs if isinstance(r, str)]


def _data_version_of(result: object) -> str | None:
    """Extracts dataVersion from result (TabularData / dict / any object with a dataVersion attribute)."""
    if isinstance(result, TabularData):
        return result.dataVersion
    value = result.get("dataVersion") if isinstance(result, dict) else getattr(result, "dataVersion", None)
    return value if isinstance(value, str) else None


__all__ = ["ActionEffect", "sales_action_effects"]
