"""L0 fixed Specs (port of TS: apps/sample-api/src/intents/fixed-specs.ts).

"App UI is a solidified L1 Spec" — the standard views never go through the LLM at all;
this template deterministically generates the Spec (a demonstration of adoption-ladder Step 0).

Made L0: quarterly_summary / kpi_overview / records / target_attainment
Still L1: trend / by_product (for demoing the LLM's declarative composition)
Goes to L2: custom

A builder is a pure function that assembles a UISpec template from (intent, refs), and the L0
path of compose calls it (compose.py's _generate_spec: `fixed(intent, refs.handles)`). Only the
returned UISpec's components / events / state carry over into the delivered Spec; the envelope
(kohaku / intent / dataVersion / provenance) is overwritten by the composer (_assemble_spec),
so only the template's shape needs to be prepared.

`lang` selects the language of user-visible text (titles, control labels, form copy). The default
"en" output is byte-identical to the historical single-language templates; "ja" is wired
per-language by app.py's policy pair (the language rides policy.fixedSpecs, and cache separation
rides the policy's generatorVersion — this source itself stays language-passive). Option/cell
labels come from the bilingual vocabulary (intents_catalog), the single source for both languages.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from kohaku.composer import FixedSpecSource
from kohaku.spec import SPEC_VERSION, Intent, JsonObject, QueryHandle, UISpec

from .intents_catalog import group_by as group_by_vocab
from .intents_catalog import region as region_vocab

# Output language of the fixed (L0) Specs. Matches app.py's policy pair (mirrors TS OutputLang).
type OutputLang = Literal["en", "ja"]

# A fixed-spec builder assembles a UISpec from a normalized Intent and resolved references.
SpecBuilder = Callable[[Intent, list[QueryHandle]], UISpec]

# The TS GROUP_LABELS (headings for the aggregation axis; a separate curation from vocab's region label).
_GROUP_LABELS: dict[str, str] = {"region": "Region", "product": "Product", "channel": "Channel"}


def _group_by_phrase(group_by: str, lang: OutputLang) -> str:
    """"by Region" (EN title fragment) / "地域別" (JA, straight from the groupBy vocabulary)."""
    if lang == "ja":
        return group_by_vocab.label(group_by, "ja")
    return f"by {_GROUP_LABELS.get(group_by, group_by)}"


def _period(p: JsonObject, lang: OutputLang) -> str:
    """Period prefix: "FY2026 Q3" (EN) / "2026年度Q3" (JA). Quarter omitted when absent."""
    fy = f"{p.get('fiscalYear')}年度" if lang == "ja" else f"FY{p.get('fiscalYear')}"
    if p.get("quarter") is None:
        return fy
    return f"{fy}Q{p.get('quarter')}" if lang == "ja" else f"{fy} Q{p.get('quarter')}"


def _region_suffix(params: JsonObject, lang: OutputLang) -> str:
    region = params.get("region")
    if region is None:
        return ""
    return f" — {region_vocab.label(str(region), lang)}"


def _region_options(lang: OutputLang) -> list[dict[str, str]]:
    """Plain {value,label} options in the requested language (the overlay map itself is not embedded in Specs)."""
    return [
        {"value": opt["value"], "label": region_vocab.label(opt["value"], lang)}
        for opt in region_vocab.options()
    ]


def _quarterly_summary(intent: Intent, refs: list[QueryHandle], lang: OutputLang) -> UISpec:
    p = intent.params
    group_by = str(p.get("groupBy", "region"))
    if lang == "ja":
        title = f"{_period(p, lang)} 売上({_group_by_phrase(group_by, lang)}){_region_suffix(p, lang)}"
    else:
        title = f"{_period(p, lang)} Sales ({_group_by_phrase(group_by, lang)}){_region_suffix(p, lang)}"
    # Assumes catalog's sales.quarterly_summary.to_queries returns only the single [summary].
    ref = refs[0].uri

    # Cross-filter demonstration (A1 two-way binding): when region is specified, wire up control.select and
    # data.bind(region) and perform region switching by in-client re-resolution without a compose round-trip.
    region = p.get("region")
    if region is not None:
        return _cross_filter_summary(intent, ref, group_by, str(region), lang)

    components: list[dict[str, Any]] = [
        {
            "id": "root",
            "type": "layout.stack",
            "props": {"direction": "vertical", "gap": "md"},
            "children": ["t", "c", "g"],
        },
        {"id": "t", "type": "text.heading", "props": {"level": 2, "text": title}},
        {
            "id": "c",
            "type": "presentChart",
            "props": {"kind": "bar", "x": group_by, "y": "revenue"},
            "data": {"$ref": ref},
        },
        {"id": "g", "type": "presentSpreadsheet", "props": {"editable": False}, "data": {"$ref": ref}},
    ]
    events: list[dict[str, Any]] = (
        [{"on": "g.rowClick", "emit": "intent.patch", "payload": {"drilldown": "$row.region"}}]
        if group_by == "region"
        else []
    )
    return _template(intent, components, events)


def _cross_filter_summary(
    intent: Intent, ref: str, group_by: str, region: str, lang: OutputLang
) -> UISpec:
    """L0 fixed Spec for the region cross-filter (A1 two-way binding demonstration).

    Wires up a chart/table with control.select(region) + data.bind(region), performing region switching
    without a compose round-trip (in-client effective-ref re-resolution). $ref is the initial variant including
    region. The bind's values are identical to catalog's region enum (vocab's region.bind_values()), which is
    the source of truth for capability variant enumeration.
    """
    p = intent.params
    # Binding that replaces the region parameter with $state.region. values = the sole source of truth for authorization and enumeration.
    region_bind = {"region": {"$state": "region", "values": region_vocab.bind_values()}}
    if lang == "ja":
        heading = f"{_period(p, lang)} 地域クロスフィルター({_group_by_phrase(group_by, lang)}の内訳)"
        hint = (
            "地域を切り替えると、compose の往復(サーバー往復 / LLM)**なし**にチャートと表が再解決されます — "
            "`data.bind` によりクライアント内部で実効 ref が差し替わります。"
        )
        filter_label = "地域"
    else:
        heading = (
            f"{_period(p, lang)} Region cross-filter (breakdown {_group_by_phrase(group_by, lang)})"
        )
        hint = (
            "Switching the region re-resolves the chart and table "
            "**without a compose round-trip (server round-trip / LLM)** — "
            "the effective ref inside the client is swapped via `data.bind`."
        )
        filter_label = "Region"
    components: list[dict[str, Any]] = [
        {
            "id": "root",
            "type": "layout.stack",
            "props": {"direction": "vertical", "gap": "md"},
            "children": ["t", "hint", "filter", "c", "g"],
        },
        {
            "id": "t",
            "type": "text.heading",
            "props": {"level": 2, "text": heading},
        },
        {
            "id": "hint",
            "type": "presentMarkdown",
            "props": {"markdown": hint},
        },
        {
            "id": "filter",
            "type": "control.select",
            "props": {"label": filter_label, "value": region, "options": _region_options(lang)},
        },
        {
            "id": "c",
            "type": "presentChart",
            "props": {"kind": "bar", "x": group_by, "y": "revenue"},
            "data": {"$ref": ref, "bind": region_bind},
        },
        {
            "id": "g",
            "type": "presentSpreadsheet",
            "props": {"editable": False},
            "data": {"$ref": ref, "bind": region_bind},
        },
    ]
    # filter.change -> state.set(region). Completed inside the Renderer (nothing sent to the server); the bound parts are re-resolved.
    events: list[dict[str, Any]] = [
        {"on": "filter.change", "emit": "state.set", "payload": {"key": "region", "value": "$value"}}
    ]
    return _template(intent, components, events, {"region": region})


def _kpi_overview(intent: Intent, refs: list[QueryHandle], lang: OutputLang) -> UISpec:
    p = intent.params
    if p.get("quarter") is not None:
        scope = _period(p, lang)
    else:
        scope = f"{_period(p, lang)} 通年" if lang == "ja" else f"{_period(p, lang)} Full year"
    title = f"{scope} 業績サマリー" if lang == "ja" else f"{scope} Performance Summary"
    components: list[dict[str, Any]] = [
        {
            "id": "root",
            "type": "layout.stack",
            "props": {"direction": "vertical", "gap": "md"},
            "children": ["t", "grid"],
        },
        {"id": "t", "type": "text.heading", "props": {"level": 2, "text": title}},
        {
            "id": "grid",
            "type": "layout.grid",
            "props": {"columns": 4, "gap": "md"},
            "children": [f"k{i}" for i in range(len(refs))],
        },
        *[
            {"id": f"k{i}", "type": "sales.kpiCard", "props": {}, "data": {"$ref": ref.uri}}
            for i, ref in enumerate(refs)
        ],
    ]
    return _template(intent, components, [])


def _records_view(intent: Intent, refs: list[QueryHandle], lang: OutputLang) -> UISpec:
    p = intent.params
    ja = lang == "ja"
    scope = " ".join(
        s
        for s in [
            (
                (f"{p['fiscalYear']}年度" if ja else f"FY{p['fiscalYear']}")
                if p.get("fiscalYear") is not None
                else ("全期間" if ja else "All periods")
            ),
            f"Q{p['quarter']}" if p.get("quarter") is not None else None,
            (
                region_vocab.label(str(p["region"]), lang)
                if p.get("region") is not None
                else None
            ),
        ]
        if s
    )
    # The $ref of the records. The invalidation target of the write loop (the table below) and the form's payload.refs point to the same reference.
    ref = refs[0].uri
    limit = p.get("limit", 100)
    page_size = min(max(int(limit) if isinstance(limit, (int, float, str)) else 100, 1), 500)
    # Demonstration of a declarative confirmation flow: press of the "add a note" button -> state.set(noteOpen=true) ->
    # overlay.dialog opens via visibleWhen. The presentForm inside the dialog is the body of the write loop (on submit,
    # annotate advances the data version and action_effects invalidates the same $ref with the new version -> the table
    # below re-resolves in place without a Spec swap; bulk data never passes through the model's context, the
    # reference-passing principle).
    components: list[dict[str, Any]] = [
        {
            "id": "root",
            "type": "layout.stack",
            "props": {"direction": "vertical", "gap": "md"},
            "children": ["t", "openNote", "noteDialog", "g"],
        },
        {
            "id": "t",
            "type": "text.heading",
            "props": {"level": 2, "text": f"売上明細({scope})" if ja else f"Sales Records ({scope})"},
        },
        {
            "id": "openNote",
            "type": "action.button",
            "props": {"label": "メモを追加" if ja else "Add a note", "variant": "secondary"},
        },
        {
            "id": "noteDialog",
            "type": "overlay.dialog",
            "props": {
                "title": "この明細にメモを追加" if ja else "Add a note to these records",
                "description": (
                    "書き込みは part → API へ直接(capability トークン付き)行われ、LLM のコンテキストを経由しません。"
                    if ja
                    else "Writes go part → API directly (with a capability token) and never pass through the LLM's context."
                ),
            },
            "children": ["noteForm"],
            "visibleWhen": {"ref": "$state.noteOpen", "eq": True},
        },
        {
            "id": "noteForm",
            "type": "presentForm",
            "props": {
                "action": "annotate",
                "submitLabel": "保存" if ja else "Save",
                "successMessage": (
                    "メモを保存しました(表は最新のデータバージョンで再取得されました)。"
                    if ja
                    else "Note saved (the table was refetched at the latest data version)."
                ),
                "fields": [
                    {
                        "name": "note",
                        "type": "text",
                        "label": "この明細へのメモ" if ja else "Note for these records",
                        "placeholder": "例: 北米の成長を確認" if ja else "e.g. Check North America's growth",
                        "required": True,
                    }
                ],
            },
        },
        {
            "id": "g",
            "type": "presentSpreadsheet",
            # serverSide=True routes sort/paging through the reserved _sort/_dir/_cursor/_limit params (a
            # plain data refetch per operation) instead of loading the whole result set into the browser;
            # page_size seeds the first page from `limit` in the same round trip as compose. sortChange is
            # deliberately NOT declared here: wiring it to intent.patch would re-compose (a full server round
            # trip) on every sort toggle, which defeats the point of resolving sort server-side via a cheap
            # refetch. Mirrors TS fixed-specs.ts's recordsView.
            "props": {"editable": False, "pageSize": page_size, "serverSide": True},
            "data": {"$ref": ref},
        },
    ]
    # - openNote.press -> state.set(noteOpen=true): opens the dialog via the button.
    # - noteDialog.close -> state.set(noteOpen=false): closes itself on Esc / x button / background click.
    # - noteForm.submit -> action.invoke(annotate): payload.note is the single input field,
    #   payload.refs is the table's $ref below (action_effects invalidates this reference with the new data version -> the table re-resolves).
    events: list[dict[str, Any]] = [
        {"on": "openNote.press", "emit": "state.set", "payload": {"key": "noteOpen", "value": True}},
        {"on": "noteDialog.close", "emit": "state.set", "payload": {"key": "noteOpen", "value": False}},
        {"on": "noteForm.submit", "emit": "action.invoke", "payload": {"note": "$value.note", "refs": [ref]}},
    ]
    return _template(intent, components, events, {"noteOpen": False})


def _target_attainment(intent: Intent, refs: list[QueryHandle], lang: OutputLang) -> UISpec:
    p = intent.params
    # The order of refs depends on the [targets, kpi] returned by catalog's sales.target_attainment.to_queries.
    # refs[0] = per-region targets (chart/table), refs[1] = target_attainment KPI (card).
    title = (
        f"{_period(p, lang)} 目標達成" if lang == "ja" else f"{_period(p, lang)} Target Attainment"
    )
    components: list[dict[str, Any]] = [
        {
            "id": "root",
            "type": "layout.stack",
            "props": {"direction": "vertical", "gap": "md"},
            "children": ["t", "k", "c", "g"],
        },
        {
            "id": "t",
            "type": "text.heading",
            "props": {"level": 2, "text": title},
        },
        {"id": "k", "type": "sales.kpiCard", "props": {}, "data": {"$ref": refs[1].uri}},
        {
            "id": "c",
            "type": "presentChart",
            "props": {"kind": "bar", "x": "region", "y": ["actual", "target"]},
            "data": {"$ref": refs[0].uri},
        },
        {"id": "g", "type": "presentSpreadsheet", "props": {"editable": False}, "data": {"$ref": refs[0].uri}},
    ]
    return _template(intent, components, [])


def _template(
    intent: Intent,
    components: list[dict[str, Any]],
    events: list[dict[str, Any]],
    state: dict[str, Any] | None = None,
) -> UISpec:
    """The composer (_assemble_spec) overwrites the envelope, so only the template's shape is prepared here.

    state holds the initial values of client-local state (needed to determine the initial variant of bind / visibleWhen);
    _assemble_spec carries the fixed template's state over into the delivered Spec.
    """
    wire: dict[str, Any] = {
        "kohaku": SPEC_VERSION,
        "intent": intent.to_wire(),
        "dataVersion": "template",
        "components": components,
        "events": events,
        "provenance": {"tier": "L0", "composedBy": "fixed-spec-template", "cache": "miss"},
    }
    if state is not None:
        wire["state"] = state
    return UISpec.model_validate(wire)


_LANG_BUILDERS: dict[str, Callable[[Intent, list[QueryHandle], OutputLang], UISpec]] = {
    "sales.quarterly_summary": _quarterly_summary,
    "sales.kpi_overview": _kpi_overview,
    "sales.records": _records_view,
    "sales.target_attainment": _target_attainment,
}


class _FixedSpecs:
    """FixedSpecSource implementation. Returns a builder from a canonical intent (compose calls the builder)."""

    def __init__(self, lang: OutputLang) -> None:
        self._lang = lang

    async def lookup(self, intent: Intent) -> SpecBuilder | None:
        builder = _LANG_BUILDERS.get(intent.canonical)
        if builder is None:
            return None
        lang = self._lang
        return lambda i, refs: builder(i, refs, lang)


def create_fixed_specs(lang: OutputLang = "en") -> FixedSpecSource:
    return _FixedSpecs(lang)


def language_of(locale: str | None) -> OutputLang:
    """Maps a session locale tag to the output language ("ja" prefix match — "ja", "ja-JP", … → "ja";
    everything else, including absence, stays the English default). Mirrors TS languageOf."""
    if locale == "ja" or (locale is not None and locale.startswith("ja-")):
        return "ja"
    return "en"


__all__ = ["OutputLang", "SpecBuilder", "create_fixed_specs", "language_of"]
