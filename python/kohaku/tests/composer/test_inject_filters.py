"""Port of packages/composer/test/inject-filters.test.ts (1:1): composer's deterministic L1 filter injection."""

from __future__ import annotations

import json
from typing import Any

from kohaku.composer.inject_filters import inject_filters
from kohaku.spec import (
    FilterDescriptor,
    FilterOption,
    UISpec,
    collect_capability_scopes,
    validate_spec_structure,
)

REGION = FilterDescriptor(
    param="region",
    queryParam="geo",
    paths=["summary"],
    label="Region",
    options=[
        FilterOption("japan", "Japan"),
        FilterOption("europe", "Europe"),
        FilterOption("apac", "APAC"),
    ],
)
GROUP_BY = FilterDescriptor(
    param="groupBy",
    queryParam="groupBy",
    paths=["summary"],
    label="Group by",
    options=[FilterOption("region", "By region"), FilterOption("product", "By product")],
)

REF = "query://sales/summary?geo=europe&groupBy=region"


def l1_spec(
    chart_ref: str, table_ref: str | None = None, root_type: str = "layout.stack"
) -> UISpec:
    """A normalized L1-shaped Spec: root stack with a heading, a chart and a table, both reading refs."""
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": {"canonical": "sales.summary", "params": {}, "hash": "sha256:" + "a" * 64},
            "dataVersion": "v1",
            "components": [
                {
                    "id": "root",
                    "type": root_type,
                    "props": {},
                    "children": ["title1", "chart1", "table1"],
                },
                {"id": "title1", "type": "text.heading", "props": {"text": "Sales", "level": 2}},
                {
                    "id": "chart1",
                    "type": "presentChart",
                    "props": {"kind": "bar"},
                    "data": {"$ref": chart_ref},
                },
                {
                    "id": "table1",
                    "type": "presentSpreadsheet",
                    "props": {},
                    "data": {"$ref": table_ref if table_ref is not None else chart_ref},
                },
            ],
            "events": [],
            "provenance": {"tier": "L1", "composedBy": "composer", "cache": "miss"},
        }
    )


def _errors(spec: UISpec) -> list[Any]:
    return [i for i in validate_spec_structure(spec) if i.severity == "error"]


def test_adds_control_state_event_and_bind_for_a_matching_param_and_the_result_validates() -> None:
    out = inject_filters(l1_spec(REF), [REGION])
    assert out.skipped is None
    assert out.injected == ["region"]
    spec = out.spec

    # control.select placed first, right after root and first among root's children.
    assert spec.components[1].to_wire() == {
        "id": "filter-region",
        "type": "control.select",
        "props": {
            "label": "Region",
            "value": "europe",
            "options": [
                {"value": "japan", "label": "Japan"},
                {"value": "europe", "label": "Europe"},
                {"value": "apac", "label": "APAC"},
            ],
        },
    }
    assert spec.components[0].children == ["filter-region", "title1", "chart1", "table1"]
    assert spec.state == {"region": "europe"}
    assert [e.to_wire() for e in spec.events] == [
        {
            "on": "filter-region.change",
            "emit": "state.set",
            "payload": {"key": "region", "value": "$value"},
        }
    ]
    bind = {"geo": {"$state": "region", "values": ["japan", "europe", "apac"]}}
    by_id = {c.id: c for c in spec.components}
    assert by_id["chart1"].data is not None
    assert by_id["chart1"].data.to_wire() == {"$ref": REF, "bind": bind}
    assert by_id["table1"].data is not None
    assert by_id["table1"].data.to_wire() == {"$ref": REF, "bind": bind}
    assert _errors(spec) == []


def test_leaves_the_spec_untouched_when_no_descriptor_matches_a_ref_query_param() -> None:
    spec = l1_spec("query://sales/summary?groupBy=region")
    out = inject_filters(spec, [REGION])
    assert out.injected == []
    assert out.skipped is None
    assert out.spec is spec


def test_does_not_inject_a_param_whose_current_value_is_not_among_the_options() -> None:
    spec = l1_spec("query://sales/summary?geo=mars&groupBy=region")
    out = inject_filters(spec, [REGION, GROUP_BY])
    # geo=mars is not an authorized value, so only groupBy is injected.
    assert out.injected == ["groupBy"]
    assert out.spec.state == {"groupBy": "region"}
    assert not any(c.id == "filter-region" for c in out.spec.components)


def test_skips_everything_with_variant_limit_when_the_total_variants_exceed_256() -> None:
    big = FilterDescriptor(
        param="region",
        queryParam="geo",
        paths=["summary"],
        label="Region",
        options=[FilterOption("europe" if i == 0 else f"r{i}", f"r{i}") for i in range(130)],
    )
    spec = l1_spec(REF)
    # 130 variants per data component x 2 components = 260 > 256.
    out = inject_filters(spec, [big])
    assert out.skipped == "variant-limit"
    assert out.injected == []
    assert out.spec is spec


def test_adds_one_control_for_a_param_used_by_two_data_components_and_binds_both() -> None:
    other = "query://sales/summary?geo=europe&groupBy=product"
    out = inject_filters(l1_spec(REF, other), [REGION])
    assert out.injected == ["region"]
    assert sum(1 for c in out.spec.components if c.type == "control.select") == 1
    assert sum(1 for e in out.spec.events if e.emit == "state.set") == 1
    by_id = {c.id: c for c in out.spec.components}
    assert by_id["chart1"].data is not None and by_id["chart1"].data.bind is not None
    assert by_id["table1"].data is not None and by_id["table1"].data.bind is not None


def test_collect_capability_scopes_enumerates_the_read_scope_of_every_variant() -> None:
    out = inject_filters(l1_spec(REF), [REGION])
    reads = sorted(s.ref for s in collect_capability_scopes(out.spec) if s.kind == "read")
    assert reads == [
        "query://sales/summary?geo=apac&groupBy=region",
        "query://sales/summary?geo=europe&groupBy=region",
        "query://sales/summary?geo=japan&groupBy=region",
    ]


def test_orders_controls_by_descriptor_order_and_combines_their_binds() -> None:
    out = inject_filters(l1_spec(REF), [GROUP_BY, REGION])
    assert out.injected == ["groupBy", "region"]
    assert [c.id for c in out.spec.components[1:3]] == ["filter-groupBy", "filter-region"]
    assert out.spec.state == {"groupBy": "region", "region": "europe"}
    # 3 regions x 2 groupBy = 6 variants per data component.
    assert len([s for s in collect_capability_scopes(out.spec) if s.kind == "read"]) == 6


def test_is_a_no_op_for_an_empty_descriptor_list() -> None:
    spec = l1_spec(REF)
    out = inject_filters(spec, [])
    assert out.spec is spec
    assert out.injected == []
    assert out.skipped is None


def test_skips_a_descriptor_whose_id_state_key_or_event_would_collide() -> None:
    with_state = l1_spec(REF).model_copy(update={"state": {"region": "japan"}})
    assert inject_filters(with_state, [REGION]).injected == []

    wire = l1_spec(REF).to_wire()
    wire["components"].append(
        {"id": "filter-region", "type": "text.heading", "props": {"text": "x", "level": 2}}
    )
    wire["components"][0]["children"].append("filter-region")
    with_id = UISpec.model_validate(wire)
    assert inject_filters(with_id, [REGION]).injected == []


def test_skips_a_descriptor_when_the_data_components_disagree_on_the_current_value() -> None:
    spec = l1_spec(REF, "query://sales/summary?geo=japan&groupBy=region")
    assert inject_filters(spec, [REGION]).injected == []


def test_returns_invalid_and_the_input_spec_when_the_root_cannot_host_controls() -> None:
    spec = l1_spec(REF, root_type="layout.tabs")
    out = inject_filters(spec, [REGION])
    assert out.skipped == "invalid"
    assert out.spec is spec


def test_does_not_mutate_its_input() -> None:
    spec = l1_spec(REF)
    before = json.dumps(spec.to_wire(), sort_keys=True)
    inject_filters(spec, [REGION, GROUP_BY])
    assert json.dumps(spec.to_wire(), sort_keys=True) == before


def test_binds_only_the_data_components_whose_ref_path_is_one_of_the_descriptors_paths() -> None:
    spec = l1_spec(REF, "query://sales/trend?geo=europe&groupBy=region")
    out = inject_filters(spec, [REGION])
    assert out.injected == ["region"]
    by_id = {c.id: c for c in out.spec.components}
    assert by_id["chart1"].data is not None and by_id["chart1"].data.bind is not None
    # The table reads another path (trend) that happens to carry the same query parameter name: untouched.
    assert by_id["table1"].data is not None
    assert by_id["table1"].data.to_wire() == {
        "$ref": "query://sales/trend?geo=europe&groupBy=region"
    }
    assert len([s for s in collect_capability_scopes(out.spec) if s.kind == "read"]) == 4


def test_injects_nothing_when_no_data_component_reads_a_governed_path() -> None:
    from dataclasses import replace

    out = inject_filters(
        l1_spec(REF), [replace(REGION, paths=["trend"]), replace(GROUP_BY, paths=[])]
    )
    assert out.injected == []
    assert out.skipped is None


def test_leaves_a_component_already_bound_on_the_query_param_to_its_own_declaration() -> None:
    wire = l1_spec(REF).to_wire()
    wire["state"] = {"own": "europe"}
    wire["components"][2]["data"] = {
        "$ref": REF,
        "bind": {"geo": {"$state": "own", "values": ["europe", "japan"]}},
    }
    assert inject_filters(UISpec.model_validate(wire), [REGION]).injected == []


def test_skips_a_descriptor_whose_query_param_is_in_the_reserved_namespace() -> None:
    from dataclasses import replace

    reserved = replace(REGION, queryParam="_limit")
    spec = l1_spec("query://sales/summary?geo=europe")
    assert inject_filters(spec, [reserved]).injected == []


def test_de_duplicates_options_by_value_first_wins() -> None:
    from dataclasses import replace

    dup = replace(
        REGION,
        options=[
            FilterOption("europe", "Europe"),
            FilterOption("japan", "Japan"),
            FilterOption("europe", "Europe again"),
        ],
    )
    out = inject_filters(l1_spec(REF), [dup])
    control = next(c for c in out.spec.components if c.id == "filter-region")
    assert control.props["options"] == [
        {"value": "europe", "label": "Europe"},
        {"value": "japan", "label": "Japan"},
    ]
    chart = next(c for c in out.spec.components if c.id == "chart1")
    assert chart.data is not None and chart.data.bind is not None
    assert chart.data.bind["geo"].to_wire() == {"$state": "region", "values": ["europe", "japan"]}


def test_ignores_a_second_descriptor_for_the_same_param_or_the_same_query_param() -> None:
    from dataclasses import replace

    same_param = inject_filters(l1_spec(REF), [REGION, replace(REGION, label="Other")])
    assert same_param.injected == ["region"]
    same_query_param = inject_filters(
        l1_spec(REF), [REGION, replace(GROUP_BY, param="area", queryParam="geo")]
    )
    assert same_query_param.injected == ["region"]


def test_is_idempotent_a_second_pass_injects_nothing() -> None:
    once = inject_filters(l1_spec(REF), [REGION, GROUP_BY])
    twice = inject_filters(once.spec, [REGION, GROUP_BY])
    assert twice.injected == []
    assert twice.spec is once.spec


def test_returns_invalid_when_the_injected_spec_fails_structural_validation() -> None:
    legacy = l1_spec(REF).model_copy(update={"kohaku": "0.1"})
    out = inject_filters(legacy, [REGION])
    assert out.skipped == "invalid"
    assert out.spec is legacy


def test_caps_the_variants_at_max_variants_default_64_never_above_256() -> None:
    from dataclasses import replace

    def opts(n: int) -> FilterDescriptor:
        return replace(
            REGION,
            options=[FilterOption("europe" if i == 0 else f"r{i}", f"r{i}") for i in range(n)],
        )

    # 2 data components x 32 values = 64: at the default cap.
    assert inject_filters(l1_spec(REF), [opts(32)]).injected == ["region"]
    # 2 x 33 = 66 > 64.
    assert inject_filters(l1_spec(REF), [opts(33)]).skipped == "variant-limit"
    # An explicit cap changes the answer both ways.
    assert inject_filters(l1_spec(REF), [opts(33)], max_variants=66).injected == ["region"]
    assert inject_filters(l1_spec(REF), [opts(3)], max_variants=5).skipped == "variant-limit"
    # ...but never above MAX_BIND_VARIANTS (2 x 130 = 260).
    assert inject_filters(l1_spec(REF), [opts(130)], max_variants=10_000).skipped == "variant-limit"
