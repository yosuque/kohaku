"""Port of apps/sample-api/test/l1-filters-shape.test.ts.

Regression for the shape-changing filters (Codex C9): an injected L1 filter swaps one bound query parameter, so
the generated chart / table keeps the x / y / columns props of the initial variant. Every filter the sample
catalog still derives must therefore leave the result's column names unchanged, for every option and every
initial value -- metric (revenue -> units), granularity (month -> quarter) and groupBy (region -> product) are
declared `filterable=False` precisely because they do not.
"""

from __future__ import annotations

import pytest

from kohaku.spec import FilterDescriptor, parse_query_ref
from sales_api.domain import shape_of
from sales_api.intents_catalog import INTENT_DEFS

_FILTERED = [(d, f) for d in INTENT_DEFS if d.filters is not None for f in d.filters()]


def _column_names(path: str, params: dict[str, str]) -> list[str]:
    shape = shape_of(path, params)
    return sorted(c.name for c in (shape.columns if shape is not None else []))


def test_derives_filters_for_the_shape_stable_facets_only() -> None:
    names = [f"{d.name}.{f.param}" for d, f in _FILTERED]
    assert "sales.trend.region" in names
    assert "sales.quarterly_summary.region" in names
    for shape_changing in ("metric", "granularity", "groupBy"):
        assert [n for n in names if n.endswith(f".{shape_changing}")] == []


@pytest.mark.parametrize(
    ("def_name", "filter_"),
    [(d.name, f) for d, f in _FILTERED],
    ids=[f"{d.name}.{f.param}" for d, f in _FILTERED],
)
def test_switching_a_filter_keeps_the_column_names_of_every_governed_ref(
    def_name: str, filter_: FilterDescriptor
) -> None:
    d = next(x for x in INTENT_DEFS if x.name == def_name)
    for handle in d.to_queries(d.params.parse({})):
        ref = parse_query_ref(handle.uri)
        if ref.path not in filter_.paths:
            continue
        expected = _column_names(ref.path, ref.params)
        assert len(expected) > 0
        for option in filter_.options:
            assert (
                _column_names(ref.path, {**ref.params, filter_.queryParam: option.value})
                == expected
            )
