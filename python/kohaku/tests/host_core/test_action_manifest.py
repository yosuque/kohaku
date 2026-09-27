"""Tests for build_action_manifest (port of packages/host-core/test/action-manifest.test.ts)."""

from __future__ import annotations

from typing import Any

from kohaku.host_core.action_manifest import build_action_manifest
from kohaku.host_core.operation_index import OperationIndexEntry
from kohaku.spec import IntentInput, OperationDescriptor, UISpec, finalize_intent


def _spec_with_actions(*actions: str) -> UISpec:
    intent = finalize_intent(IntentInput(canonical="sales.trend", params={}))
    data: dict[str, Any] = {
        "kohaku": "0.2",
        "intent": intent.to_wire(),
        "dataVersion": "v1",
        "components": [{"id": "root", "type": "layout.stack", "props": {}, "children": []}],
        "events": [
            {"on": f"root.event{i}", "emit": "action.invoke", "payload": {"action": action}}
            for i, action in enumerate(actions)
        ],
        "provenance": {"tier": "L0", "composedBy": "fixture", "cache": "miss"},
    }
    return UISpec.model_validate(data)


def _index_of(*descriptors: OperationDescriptor) -> dict[str, OperationIndexEntry]:
    return {d.name: OperationIndexEntry(descriptor=d, params_schema=d.paramsSchema) for d in descriptors}


def test_returns_none_when_the_spec_declares_no_write_actions() -> None:
    spec = _spec_with_actions()
    assert build_action_manifest(spec, _index_of()) is None


def test_builds_one_entry_per_declared_write_action_that_is_a_real_domain_operation() -> None:
    spec = _spec_with_actions("annotate", "publish")
    index = _index_of(
        OperationDescriptor(
            name="annotate",
            description="d",
            tier="confirm",
            confirmMessage="Are you sure?",
            paramsSchema={"type": "object", "properties": {"note": {"type": "string"}}},
        ),
        OperationDescriptor(name="publish", description="d"),
    )
    manifest = build_action_manifest(spec, index)
    assert manifest is not None
    assert manifest["annotate"].tier == "confirm"
    assert manifest["annotate"].confirmMessage == "Are you sure?"
    assert manifest["annotate"].paramsSchema == {"type": "object", "properties": {"note": {"type": "string"}}}
    assert manifest["publish"].tier == "auto"
    assert manifest["publish"].paramsSchema is None


def test_silently_omits_a_declared_action_that_is_not_a_real_domain_operation() -> None:
    spec = _spec_with_actions("annotate", "hallucinated")
    index = _index_of(OperationDescriptor(name="annotate", description="d"))
    manifest = build_action_manifest(spec, index)
    assert manifest is not None
    assert list(manifest.keys()) == ["annotate"]


def test_returns_none_not_empty_dict_when_every_declared_action_was_dropped() -> None:
    spec = _spec_with_actions("hallucinated")
    assert build_action_manifest(spec, _index_of()) is None


def test_defaults_tier_to_auto_when_the_descriptor_omits_it() -> None:
    spec = _spec_with_actions("annotate")
    index = _index_of(OperationDescriptor(name="annotate", description="d"))
    manifest = build_action_manifest(spec, index)
    assert manifest is not None
    assert manifest["annotate"].tier == "auto"
