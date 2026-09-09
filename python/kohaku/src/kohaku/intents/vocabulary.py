"""The single source of a value set (values + display labels) (port of vocabulary.ts).

enum, GUI options, data.bind values, and drilldown's label reverse-lookup are all derived from here
(consolidating duplicate value-set descriptions into one place). An entry is either a single
canonical (English) label, or a per-locale label map whose "en" key is the canonical label and every
other key is a locale overlay (e.g. "ja").
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .param_schema import EnumField

type VocabularyEntry = str | dict[str, str]


@dataclass(frozen=True)
class Vocabulary:
    """The single source of a value set + display labels. Built with define_vocabulary."""

    name: str
    values: tuple[str, ...]
    """enum members / bind values (insertion order)."""
    labels: dict[str, str]
    """value → canonical (English) display label."""
    _overlays: dict[str, dict[str, str]] = field(repr=False, default_factory=dict)
    """value → locale → label, non-en locales only (what options() emits as the overlay)."""
    _code_by_label: dict[str, str] = field(repr=False, default_factory=dict)
    """The reverse lookup label → code across all locales (on duplicates, first-wins by insertion order). For drilldown."""

    def enum(self) -> EnumField:
        """→ The enum field equivalent to Zod catalog params / MCP inputSchema."""
        return EnumField(values=self.values)

    def options(self) -> list[dict[str, Any]]:
        """→ GUI facet options (value + canonical label + locale overlays when declared)."""
        out: list[dict[str, Any]] = []
        for value in self.values:
            entry: dict[str, Any] = {"value": value, "label": self.labels[value]}
            overlay = self._overlays.get(value)
            if overlay:
                entry["labels"] = dict(overlay)
            out.append(entry)
        return out

    def label(self, value: str, locale: str | None = None) -> str:
        """→ Display (localizing a cell value). Overlay first, then the canonical label; an unknown value is returned as-is."""
        if locale is not None:
            overlay = self._overlays.get(value)
            if overlay is not None and locale in overlay:
                return overlay[locale]
        return self.labels.get(value, value)

    def reverse_label(self, label: str) -> str | None:
        """→ drilldown's label → code reverse lookup, matching labels of every declared locale. An unknown label is None."""
        return self._code_by_label.get(label)

    def bind_values(self) -> list[str]:
        """→ A1 data.bind values (a copy of values)."""
        return list(self.values)


def define_vocabulary(name: str, entries: dict[str, VocabularyEntry]) -> Vocabulary:
    """Build a Vocabulary from a label map (code → entry; insertion order is the options / enum order).

    Passing a domain's REGION_LABELS etc. as-is makes it the single source of the value set.
    Plain-string entries stay canonical-only (backward compatible); dict entries add locale
    overlays on top of the "en" canonical.
    """
    values = tuple(entries.keys())
    if not values:
        raise ValueError(f'Vocabulary "{name}" requires at least one value')
    labels: dict[str, str] = {}
    overlays: dict[str, dict[str, str]] = {}
    for value in values:
        entry = entries[value]
        if isinstance(entry, str):
            labels[value] = entry
            continue
        labels[value] = entry["en"]
        overlay = {locale: text for locale, text in entry.items() if locale != "en"}
        if overlay:
            overlays[value] = overlay
    # The reverse lookup label → code across all locales. On duplicate labels, first-wins
    # (the first value in insertion order; within a value, canonical before overlays).
    code_by_label: dict[str, str] = {}
    for value in values:
        for label in [labels[value], *overlays.get(value, {}).values()]:
            if label not in code_by_label:
                code_by_label[label] = value
    return Vocabulary(
        name=name,
        values=values,
        labels=labels,
        _overlays=overlays,
        _code_by_label=code_by_label,
    )
