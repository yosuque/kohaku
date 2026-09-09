"""Unit tests for canonical JSON (Python-specific behaviors the cross-language golden cannot cover)."""

from __future__ import annotations

import math

import pytest

from kohaku.spec import UNDEFINED, canonical_stringify, js_string, normalize_json_value


class TestCanonicalStringify:
    def test_undefined_dict_value_is_dropped(self) -> None:
        assert canonical_stringify({"a": 1, "b": UNDEFINED}) == '{"a":1}'

    def test_undefined_array_element_becomes_null(self) -> None:
        assert canonical_stringify([1, UNDEFINED, 2]) == "[1,null,2]"

    def test_undefined_top_level_raises(self) -> None:
        with pytest.raises(TypeError):
            canonical_stringify(UNDEFINED)

    def test_nan_and_infinity_raise(self) -> None:
        for bad in (math.nan, math.inf, -math.inf):
            with pytest.raises(TypeError):
                canonical_stringify(bad)
            with pytest.raises(TypeError):
                normalize_json_value(bad)

    def test_huge_int_raises_like_infinity(self) -> None:
        with pytest.raises(TypeError):
            canonical_stringify(10**400)

    def test_int_beyond_safe_range_formats_as_double(self) -> None:
        # 2^53 + 1 rounds to 2^53 as a double (the same loss as JS's JSON.parse)
        assert canonical_stringify(2**53 + 1) == "9007199254740992"
        assert canonical_stringify(10**21) == "1e+21"

    def test_non_string_key_raises(self) -> None:
        with pytest.raises(TypeError):
            canonical_stringify({1: "a"})

    def test_array_index_keys_come_first_in_numeric_order(self) -> None:
        # ES OrdinaryOwnPropertyKeys: "2" < "10" (numeric order) comes before non-index keys
        assert (
            canonical_stringify({"b": 1, "10": 2, "2": 3, "a": 4})
            == '{"2":3,"10":2,"a":4,"b":1}'
        )
        # a leading zero ("01") or >= 2^32-1 is not an array index
        assert canonical_stringify({"01": 1, "1": 2}) == '{"1":2,"01":1}'
        assert canonical_stringify({"4294967295": 1, "4294967294": 2}) == (
            '{"4294967294":2,"4294967295":1}'
        )

    def test_negative_zero_normalizes_to_zero(self) -> None:
        assert canonical_stringify(-0.0) == "0"
        assert canonical_stringify([-0.0]) == "[0]"


class TestNormalizeJsonValue:
    def test_sorts_keys_deeply(self) -> None:
        out = normalize_json_value({"b": {"d": 1, "c": 2}, "a": 3})
        assert isinstance(out, dict)
        assert list(out.keys()) == ["a", "b"]
        inner = out["b"]
        assert isinstance(inner, dict)
        assert list(inner.keys()) == ["c", "d"]


class TestJsString:
    def test_primitives(self) -> None:
        assert js_string(None) == "null"
        assert js_string(UNDEFINED) == "undefined"
        assert js_string(True) == "true"
        assert js_string(False) == "false"
        assert js_string("s") == "s"

    def test_numbers_use_es_formatting(self) -> None:
        assert js_string(1.0) == "1"  # String(1.0) === "1"
        assert js_string(1.5) == "1.5"
        assert js_string(1e21) == "1e+21"

    def test_array_and_object(self) -> None:
        assert js_string([1, None, "a"]) == "1,,a"  # null elements are empty strings
        assert js_string({"a": 1}) == "[object Object]"
