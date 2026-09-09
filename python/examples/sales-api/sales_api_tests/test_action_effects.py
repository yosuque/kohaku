"""Test for write side effects (port of TS: apps/sample-api/src/action-effects.ts).

Because annotate advances the data version, it invalidates payload.refs with the new version. Untargeted actions have no side effects.
"""

from __future__ import annotations

import asyncio

from kohaku.spec import JsonObject
from sales_api.action_effects import sales_action_effects


class TestSalesActionEffects:
    def test_non_annotate_has_no_effect(self) -> None:
        effect = asyncio.run(sales_action_effects("other", {"refs": ["query://sales/kpi"]}, None))
        assert effect.invalidates is None
        assert effect.refVersions is None

    def test_annotate_with_refs_and_data_version(self) -> None:
        payload: JsonObject = {"refs": ["query://sales/kpi", "query://sales/trend"]}
        result = {"dataVersion": "sales@seed#bump-1"}
        effect = asyncio.run(sales_action_effects("annotate", payload, result))
        assert effect.invalidates == ["query://sales/kpi", "query://sales/trend"]
        assert effect.refVersions == {
            "query://sales/kpi": "sales@seed#bump-1",
            "query://sales/trend": "sales@seed#bump-1",
        }

    def test_annotate_with_no_refs(self) -> None:
        effect = asyncio.run(
            sales_action_effects("annotate", {}, {"dataVersion": "sales@seed#bump-1"})
        )
        assert effect.invalidates == []
        assert effect.refVersions is None

    def test_annotate_without_data_version(self) -> None:
        # If result has no dataVersion, refVersions is not attached and only invalidates is returned.
        effect = asyncio.run(
            sales_action_effects("annotate", {"refs": ["query://sales/kpi"]}, None)
        )
        assert effect.invalidates == ["query://sales/kpi"]
        assert effect.refVersions is None

    def test_non_string_refs_are_dropped(self) -> None:
        payload: JsonObject = {"refs": ["query://sales/kpi", 123, None]}
        effect = asyncio.run(
            sales_action_effects("annotate", payload, {"dataVersion": "sales@seed#bump-1"})
        )
        assert effect.invalidates == ["query://sales/kpi"]
