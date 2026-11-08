"""Field-level diff between a machine-extracted schema suggestion and the draft a reviewer submitted
(Port of TS packages/lineage/src/promotion/suggestion.ts).

The suggestion itself (`SchemaSuggestion`) is a wire-contract type shared by evals (which produces it) and
lineage (which persists it), so it lives in `kohaku.spec` (see `kohaku.spec.suggestion`), mirroring TS's
spec-core placement. On a `PromotionCandidate` it is carried in its wire form (a plain dict): this port keeps
`verdict` / `origin` the same way, and it lets a malformed persisted `data["suggestion"]` (a truncated write,
a hand-edited promotions.json) flow through to the approve path's fail-open handling instead of being rejected
on load.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, NotRequired, TypedDict

from kohaku.spec import canonical_stringify

DraftDiffField = Literal[
    "componentType",
    "version",
    "intentName",
    "description",
    "paramsJsonSchema",
    "queryTemplate",
]

DRAFT_DIFF_FIELDS: tuple[DraftDiffField, ...] = (
    "componentType",
    "version",
    "intentName",
    "description",
    "paramsJsonSchema",
    "queryTemplate",
)
"""The fixed field order the diff reports in (it is what `component.schemaEdited` records and what few-shot
mining reads later, so it is not the insertion order of either input)."""


class DraftFieldChange(TypedDict):
    """One changed field. `suggested` / `final` are omitted when that side has no such key (TS's `undefined`);
    an explicit JSON `null` is a value and is kept."""

    field: DraftDiffField
    suggested: NotRequired[Any]
    final: NotRequired[Any]


class DraftDiff(TypedDict):
    changed: list[DraftFieldChange]
    unchanged: list[DraftDiffField]


def _field_key(fields: Mapping[str, Any], field: str) -> str:
    """Canonical JSON of a draft field. Only an *absent* key compares as the empty string (TS's `undefined`);
    an explicit JSON `null` is a value and compares as `"null"`, so absent and `null` are different."""
    return canonical_stringify(fields[field]) if field in fields else ""


def _draft_fields(draft: Any) -> Mapping[str, Any]:
    """The wire-form fields of a draft: a ComponentDraft / SuggestedDraft (via `to_wire`) or an already-wire dict.

    Anything else (notably None, a suggestion that exists but lost its `draft`) raises, like TS's `suggested[field]`
    on undefined; the approve path treats that as a fail-open audit failure.
    """
    to_wire = getattr(draft, "to_wire", None)
    if callable(to_wire):
        wire = to_wire()
        if isinstance(wire, Mapping):
            return wire
    if isinstance(draft, Mapping):
        return draft
    raise TypeError(f"a draft must be a mapping or expose to_wire(), got {type(draft).__name__}")


def diff_draft(suggested: Any, final: Any) -> DraftDiff:
    """Field-level diff between the extractor's suggested draft and the draft the reviewer finally submitted.

    Pure. Object fields (paramsJsonSchema / queryTemplate) are compared by canonical JSON, so a reviewer who only
    re-ordered keys did not "edit" the field. Returns `{"changed": [{"field", "suggested"?, "final"?}, ...],
    "unchanged": [field, ...]}`; an absent side is omitted from a change entry (TS's `undefined`).
    """
    suggested_fields = _draft_fields(suggested)
    final_fields = _draft_fields(final)
    changed: list[DraftFieldChange] = []
    unchanged: list[DraftDiffField] = []
    for field in DRAFT_DIFF_FIELDS:
        if _field_key(suggested_fields, field) == _field_key(final_fields, field):
            unchanged.append(field)
        else:
            change: DraftFieldChange = {"field": field}
            if field in suggested_fields:
                change["suggested"] = suggested_fields[field]
            if field in final_fields:
                change["final"] = final_fields[field]
            changed.append(change)
    return {"changed": changed, "unchanged": unchanged}


__all__ = [
    "DRAFT_DIFF_FIELDS",
    "DraftDiff",
    "DraftDiffField",
    "DraftFieldChange",
    "diff_draft",
]
