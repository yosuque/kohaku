"""Tests for kohaku.storage._wire's compact JSON writer (the text a Redis value / Postgres text column holds)."""

from __future__ import annotations

import json

from kohaku.storage._wire import dumps_compact


def test_writes_no_whitespace_and_leaves_non_ascii_unescaped_like_json_stringify() -> None:
    assert (
        dumps_compact({"a": [1, {"b": "日本 \U0001f600"}]}) == '{"a":[1,{"b":"日本 \U0001f600"}]}'
    )


def test_writes_null_for_non_finite_numbers_like_json_stringify() -> None:
    # JSON.stringify({a: NaN, b: [Infinity, -Infinity], c: {d: NaN}}) === '{"a":null,"b":[null,null],"c":{"d":null}}'
    text = dumps_compact(
        {"a": float("nan"), "b": [float("inf"), float("-inf")], "c": {"d": float("nan")}, "e": 1.5}
    )
    assert text == '{"a":null,"b":[null,null],"c":{"d":null},"e":1.5}'
    assert json.loads(text)["a"] is None  # valid JSON, unlike Python's default NaN token


def test_leaves_a_structure_without_non_finite_numbers_untouched() -> None:
    value = {"a": [1, 2.5, {"b": None}], "c": "x"}
    assert dumps_compact(value) == '{"a":[1,2.5,{"b":null}],"c":"x"}'
