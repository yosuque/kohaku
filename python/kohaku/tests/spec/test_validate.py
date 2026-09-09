"""Tests for each issue code of structural validation (validate_spec_structure)."""

from __future__ import annotations

from typing import Any

from kohaku.spec import UISpec, validate_spec_structure


def _spec(**overrides: Any) -> UISpec:
    base: dict[str, Any] = {
        "kohaku": "0.2",
        "intent": {
            "canonical": "sales.summary",
            "params": {},
            "hash": "sha256:" + "0" * 64,
        },
        "dataVersion": "v1",
        "components": [{"id": "root", "type": "layout.stack"}],
        "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
    }
    base.update(overrides)
    return UISpec.model_validate(base)


def _codes(spec: UISpec) -> list[str]:
    return [i.code for i in validate_spec_structure(spec)]


def test_valid_spec_has_no_issues() -> None:
    assert _codes(_spec()) == []


def test_duplicate_id() -> None:
    spec = _spec(
        components=[
            {"id": "root", "type": "x", "children": ["a"]},
            {"id": "a", "type": "x"},
            {"id": "a", "type": "y"},
        ]
    )
    assert "DUPLICATE_ID" in _codes(spec)


def test_missing_root() -> None:
    spec = _spec(components=[{"id": "a", "type": "x"}])
    codes = _codes(spec)
    assert "MISSING_ROOT" in codes


def test_dangling_child() -> None:
    spec = _spec(components=[{"id": "root", "type": "x", "children": ["ghost"]}])
    assert "DANGLING_CHILD" in _codes(spec)


def test_cycle() -> None:
    spec = _spec(
        components=[
            {"id": "root", "type": "x", "children": ["a"]},
            {"id": "a", "type": "x", "children": ["root"]},
        ]
    )
    assert "CYCLE" in _codes(spec)


def test_orphan_is_warning() -> None:
    spec = _spec(
        components=[
            {"id": "root", "type": "x"},
            {"id": "island", "type": "x"},
        ]
    )
    issues = validate_spec_structure(spec)
    orphan = [i for i in issues if i.code == "ORPHAN_COMPONENT"]
    assert len(orphan) == 1 and orphan[0].severity == "warning"


def test_multiple_sandbox_nodes_is_warning() -> None:
    sha256 = "a" * 64
    spec = _spec(
        components=[
            {"id": "root", "type": "layout.stack", "children": ["a", "b"]},
            {"id": "a", "type": "sandbox.html", "artifact": {"inline": "<p>a</p>", "sha256": sha256}},
            {"id": "b", "type": "sandbox.html", "artifact": {"inline": "<p>b</p>", "sha256": sha256}},
        ]
    )
    issues = validate_spec_structure(spec)
    multi = [i for i in issues if i.code == "MULTIPLE_SANDBOX_NODES"]
    assert len(multi) == 1 and multi[0].severity == "warning"


def test_single_sandbox_node_has_no_warning() -> None:
    sha256 = "a" * 64
    spec = _spec(
        components=[
            {"id": "root", "type": "layout.stack", "children": ["a"]},
            {"id": "a", "type": "sandbox.html", "artifact": {"inline": "<p>a</p>", "sha256": sha256}},
        ]
    )
    assert "MULTIPLE_SANDBOX_NODES" not in _codes(spec)


def test_dag_sharing_is_allowed() -> None:
    """Sharing children (a DAG) is not a cycle."""
    spec = _spec(
        components=[
            {"id": "root", "type": "x", "children": ["a", "b"]},
            {"id": "a", "type": "x", "children": ["shared"]},
            {"id": "b", "type": "x", "children": ["shared"]},
            {"id": "shared", "type": "x"},
        ]
    )
    assert _codes(spec) == []


def test_unknown_event_target() -> None:
    spec = _spec(events=[{"on": "ghost.click", "emit": "intent.patch", "payload": {}}])
    assert "UNKNOWN_EVENT_TARGET" in _codes(spec)


def test_ref_reserved_param() -> None:
    spec = _spec(
        components=[
            {
                "id": "root",
                "type": "x",
                "data": {"$ref": "query://s/p?_page=1&a=2"},
            }
        ]
    )
    assert "REF_RESERVED_PARAM" in _codes(spec)


def test_state_ref_unknown() -> None:
    spec = _spec(
        state={"known": "v"},
        components=[
            {
                "id": "root",
                "type": "x",
                "visibleWhen": {"all": [{"ref": "$state.unknown", "eq": 1}]},
            }
        ],
    )
    assert "STATE_REF_UNKNOWN" in _codes(spec)


def test_state_set_invalid_template_key() -> None:
    spec = _spec(
        state={"tab": "a"},
        events=[{"on": "root.click", "emit": "state.set", "payload": {"key": "$value"}}],
    )
    assert "STATE_SET_INVALID" in _codes(spec)


def test_state_set_undeclared_key() -> None:
    spec = _spec(
        state={"tab": "a"},
        events=[
            {"on": "root.click", "emit": "state.set", "payload": {"key": "other", "value": 1}}
        ],
    )
    assert "STATE_SET_INVALID" in _codes(spec)


class TestBindValidation:
    def _bind_spec(self, *, ref: str, state: dict[str, Any], values: list[str]) -> UISpec:
        return _spec(
            state=state,
            components=[
                {
                    "id": "root",
                    "type": "x",
                    "data": {
                        "$ref": ref,
                        "bind": {"region": {"$state": "region", "values": values}},
                    },
                }
            ],
        )

    def test_valid_bind(self) -> None:
        spec = self._bind_spec(
            ref="query://s/p?region=us", state={"region": "us"}, values=["us", "eu"]
        )
        assert _codes(spec) == []

    def test_bind_state_unknown(self) -> None:
        spec = self._bind_spec(ref="query://s/p?region=us", state={}, values=["us"])
        assert "BIND_STATE_UNKNOWN" in _codes(spec)

    def test_bind_param_missing(self) -> None:
        spec = self._bind_spec(ref="query://s/p?other=1", state={"region": "us"}, values=["us"])
        assert "BIND_PARAM_MISSING" in _codes(spec)

    def test_bind_value_invalid_not_in_values(self) -> None:
        spec = self._bind_spec(
            ref="query://s/p?region=jp", state={"region": "jp"}, values=["us", "eu"]
        )
        assert "BIND_VALUE_INVALID" in _codes(spec)

    def test_bind_value_invalid_state_mismatch(self) -> None:
        """Three-way agreement: when the $ref value and the state's initial value disagree, BIND_VALUE_INVALID."""
        spec = self._bind_spec(
            ref="query://s/p?region=us", state={"region": "eu"}, values=["us", "eu"]
        )
        assert "BIND_VALUE_INVALID" in _codes(spec)

    def test_bind_param_reserved(self) -> None:
        spec = _spec(
            state={"x": "1"},
            components=[
                {
                    "id": "root",
                    "type": "x",
                    "data": {
                        "$ref": "query://s/p?_x=1",
                        "bind": {"_x": {"$state": "x", "values": ["1"]}},
                    },
                }
            ],
        )
        codes = _codes(spec)
        assert "BIND_PARAM_RESERVED" in codes

    def test_bind_variant_limit(self) -> None:
        """When the summed Cartesian product of values exceeds 256, BIND_VARIANT_LIMIT."""
        values = [str(i) for i in range(17)]  # 17 × 17 = 289 > 256
        spec = _spec(
            state={"a": "0", "b": "0"},
            components=[
                {
                    "id": "root",
                    "type": "x",
                    "data": {
                        "$ref": "query://s/p?a=0&b=0",
                        "bind": {
                            "a": {"$state": "a", "values": values},
                            "b": {"$state": "b", "values": values},
                        },
                    },
                }
            ],
        )
        assert "BIND_VARIANT_LIMIT" in _codes(spec)
