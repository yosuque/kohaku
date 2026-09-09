"""Tests for define_vocabulary (the same scenarios as TS vocabulary.test.ts)."""

from __future__ import annotations

import pytest

from kohaku.intents import define_vocabulary

region = define_vocabulary(
    "region",
    {
        "japan": "Japan",
        "north_america": "North America",
        "europe": "Europe",
        "apac": "APAC",
    },
)


class TestDefineVocabulary:
    def test_values_and_labels_keep_insertion_order(self) -> None:
        assert region.values == ("japan", "north_america", "europe", "apac")
        assert region.labels == {
            "japan": "Japan",
            "north_america": "North America",
            "europe": "Europe",
            "apac": "APAC",
        }

    def test_enum_validates_value_set(self) -> None:
        e = region.enum()
        # The enum field's _coerce validates the value set (equivalent to z.enum's safeParse).
        assert e._coerce("japan") == "japan"
        with pytest.raises(ValueError):
            e._coerce("mars")

    def test_options_returns_value_label_in_order(self) -> None:
        assert region.options() == [
            {"value": "japan", "label": "Japan"},
            {"value": "north_america", "label": "North America"},
            {"value": "europe", "label": "Europe"},
            {"value": "apac", "label": "APAC"},
        ]

    def test_label_returns_japanese_and_passes_through_unknown(self) -> None:
        assert region.label("japan") == "Japan"
        assert region.label("unknown") == "unknown"

    def test_reverse_label_maps_label_to_code(self) -> None:
        assert region.reverse_label("Japan") == "japan"
        assert region.reverse_label("APAC") == "apac"
        # A code itself (not a label) or an unknown label is None.
        assert region.reverse_label("japan") is None
        assert region.reverse_label("Mars") is None

    def test_bind_values_returns_copy(self) -> None:
        values = region.bind_values()
        assert values == ["japan", "north_america", "europe", "apac"]
        # It must be a copy (does not corrupt the internal tuple).
        values.append("mars")
        assert region.values == ("japan", "north_america", "europe", "apac")

    def test_empty_entries_raises(self) -> None:
        with pytest.raises(ValueError):
            define_vocabulary("empty", {})


class TestLocaleOverlays:
    """Mirrors TS vocabulary.test.ts "defineVocabulary (locale overlays)"."""

    bilingual = define_vocabulary(
        "region",
        {
            "japan": {"en": "Japan", "ja": "日本"},
            "north_america": {"en": "North America", "ja": "北米"},
            # A plain-string entry may coexist with map entries (canonical-only, no overlay).
            "europe": "Europe",
        },
    )

    def test_labels_stays_canonical_english_map(self) -> None:
        assert self.bilingual.labels == {
            "japan": "Japan",
            "north_america": "North America",
            "europe": "Europe",
        }

    def test_label_picks_overlay_then_canonical_then_raw(self) -> None:
        assert self.bilingual.label("japan", "ja") == "日本"
        assert self.bilingual.label("japan", "en") == "Japan"
        assert self.bilingual.label("japan") == "Japan"
        # Overlay missing for that locale → canonical.
        assert self.bilingual.label("europe", "ja") == "Europe"
        assert self.bilingual.label("japan", "fr") == "Japan"
        # Unknown value → raw value regardless of locale.
        assert self.bilingual.label("mars", "ja") == "mars"

    def test_options_carries_overlay_only_when_declared(self) -> None:
        assert self.bilingual.options() == [
            {"value": "japan", "label": "Japan", "labels": {"ja": "日本"}},
            {"value": "north_america", "label": "North America", "labels": {"ja": "北米"}},
            {"value": "europe", "label": "Europe"},
        ]

    def test_reverse_label_resolves_every_locale(self) -> None:
        assert self.bilingual.reverse_label("Japan") == "japan"
        assert self.bilingual.reverse_label("日本") == "japan"
        assert self.bilingual.reverse_label("北米") == "north_america"
        assert self.bilingual.reverse_label("Mars") is None

    def test_duplicate_labels_across_locales_first_wins(self) -> None:
        v = define_vocabulary(
            "dup",
            {"a": {"en": "Same", "ja": "同じ"}, "b": {"en": "Other", "ja": "Same"}},
        )
        assert v.reverse_label("Same") == "a"
        assert v.reverse_label("同じ") == "a"
