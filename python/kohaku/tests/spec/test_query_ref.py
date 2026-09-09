"""Tests for parsing / canonicalizing query:// URIs (same semantics as TS query-ref.ts)."""

from __future__ import annotations

import pytest

from kohaku.spec import QueryRefError, format_query_ref, parse_query_ref


class TestParseQueryRef:
    def test_basic(self) -> None:
        ref = parse_query_ref("query://sales/summary?fy=2026&groupBy=region&q=3")
        assert ref.source == "sales"
        assert ref.path == "summary"
        assert ref.params == {"fy": "2026", "groupBy": "region", "q": "3"}
        assert ref.raw == "query://sales/summary?fy=2026&groupBy=region&q=3"

    def test_canonicalizes_param_order(self) -> None:
        ref = parse_query_ref("query://s/p?b=2&a=1")
        assert ref.raw == "query://s/p?a=1&b=2"

    def test_no_params(self) -> None:
        ref = parse_query_ref("query://s/deep/path")
        assert ref.path == "deep/path"
        assert ref.params == {}
        assert ref.raw == "query://s/deep/path"

    def test_empty_value_param_normalizes_to_eq(self) -> None:
        """An empty-value parameter `?a` is kept as the value "", and its canonical form becomes `?a=`."""
        ref = parse_query_ref("query://s/p?a")
        assert ref.params == {"a": ""}
        assert ref.raw == "query://s/p?a="

    def test_decodes_params(self) -> None:
        ref = parse_query_ref("query://s/p?q=%E5%A3%B2%E4%B8%8A&x=a%26b")
        assert ref.params == {"q": "売上", "x": "a&b"}

    def test_path_stays_encoded(self) -> None:
        """The path is kept encoded as-is and is unchanged on round-trip."""
        ref = parse_query_ref("query://s/a%20b/c?x=1")
        assert ref.path == "a%20b/c"
        assert ref.raw == "query://s/a%20b/c?x=1"

    def test_rejects_bad_scheme(self) -> None:
        for bad in ("http://s/p", "query://S/p", "query://s", "query://s/p#frag"):
            with pytest.raises(QueryRefError):
                parse_query_ref(bad)

    def test_rejects_malformed_percent(self) -> None:
        with pytest.raises(QueryRefError):
            parse_query_ref("query://s/p?a=%ZZ")


class TestFormatQueryRef:
    def test_round_trip_canonical(self) -> None:
        raw = "query://s/p?a=1&b=%E5%A3%B2"
        ref = parse_query_ref(raw)
        assert format_query_ref(source=ref.source, path=ref.path, params=ref.params) == raw

    def test_encodes_like_js(self) -> None:
        """encodeURIComponent-compatible (-_.!~*'() pass through; others become uppercase %XX)."""
        out = format_query_ref(source="s", path="p", params={"k": "a b!~*'()-_.+/"})
        assert out == "query://s/p?k=a%20b!~*'()-_.%2B%2F"
