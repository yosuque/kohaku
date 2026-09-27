"""Tests for the `actions` manifest on the compose response (port of
packages/host-rest/test/action-manifest-response.test.ts).
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any

from kohaku.composer import ComposePolicy
from kohaku.spec import IntentInput, OperationDescriptor, UISpec, compute_spec_hash, finalize_intent

from .conftest import PREFIX, REF, build_harness

INTENT_BODY: dict[str, Any] = {"canonical": "sales.summary", "params": {}}


def _fixed_spec(events: list[dict[str, Any]]) -> UISpec:
    intent = finalize_intent(IntentInput(canonical="sales.summary", params={}))
    data: dict[str, Any] = {
        "kohaku": "0.2",
        "intent": intent.to_wire(),
        "dataVersion": "v1",
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["table"]},
            {"id": "table", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": REF}},
        ],
        "events": events,
        "provenance": {"tier": "L0", "composedBy": "fixture", "cache": "miss"},
    }
    return UISpec.model_validate(data)


SPEC_WITH_ACTIONS = _fixed_spec(
    [
        {"on": "root.annotateClick", "emit": "action.invoke", "payload": {"action": "annotate"}},
        {"on": "root.publishClick", "emit": "action.invoke", "payload": {"action": "publish"}},
    ]
)
SPEC_WITHOUT_ACTIONS = _fixed_spec([])


class _FixedSpecSource:
    def __init__(self, spec: UISpec) -> None:
        self._spec = spec

    async def lookup(self, intent: Any) -> UISpec:
        return self._spec


def _with_fixed_spec(harness: Any, spec: UISpec) -> None:
    harness.deps.compose = dataclasses.replace(
        harness.ctx, policy=ComposePolicy(fixedSpecs=_FixedSpecSource(spec))
    )


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def _domain_with(*ops: OperationDescriptor) -> Any:
    class _Domain:
        async def list_operations(self) -> list[OperationDescriptor]:
            return list(ops)

        async def invoke(self, op: str, args: Any, ctx: Any) -> object:
            return {"ok": True, "op": op, "args": args}

    return _Domain()


def test_includes_an_entry_per_declared_write_action_present_in_the_operation_index(tmp_path: Path) -> None:
    domain = _domain_with(
        OperationDescriptor(name="annotate", description="d", tier="confirm", confirmMessage="Are you sure?"),
        OperationDescriptor(name="publish", description="d"),
    )
    harness = build_harness(tmp_path, domain=domain)
    _with_fixed_spec(harness, SPEC_WITH_ACTIONS)
    res = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    body = res.json()
    assert body["actions"] == {
        "annotate": {"tier": "confirm", "confirmMessage": "Are you sure?"},
        "publish": {"tier": "auto"},
    }


def test_includes_params_schema_when_the_operation_declares_one(tmp_path: Path) -> None:
    schema = {"type": "object", "properties": {"note": {"type": "string"}}}
    domain = _domain_with(
        OperationDescriptor(name="annotate", description="d", paramsSchema=schema),
        OperationDescriptor(name="publish", description="d"),
    )
    harness = build_harness(tmp_path, domain=domain)
    _with_fixed_spec(harness, SPEC_WITH_ACTIONS)
    body = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()
    assert body["actions"]["annotate"]["paramsSchema"] == schema


def test_omits_actions_entirely_when_the_spec_declares_no_write_actions(tmp_path: Path) -> None:
    domain = _domain_with(OperationDescriptor(name="annotate", description="d"))
    harness = build_harness(tmp_path, domain=domain)
    _with_fixed_spec(harness, SPEC_WITHOUT_ACTIONS)
    body = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()
    assert "actions" not in body


def test_omits_an_action_that_is_not_a_real_domain_operation(tmp_path: Path) -> None:
    domain = _domain_with()  # no operations at all
    harness = build_harness(tmp_path, domain=domain)
    _with_fixed_spec(harness, SPEC_WITH_ACTIONS)
    body = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()
    assert "actions" not in body


def test_does_not_affect_spec_hash(tmp_path: Path) -> None:
    with_ops = _domain_with(
        OperationDescriptor(name="annotate", description="d", tier="confirm"),
        OperationDescriptor(name="publish", description="d"),
    )
    without_ops = _domain_with()

    harness_with = build_harness(tmp_path, domain=with_ops)
    _with_fixed_spec(harness_with, SPEC_WITH_ACTIONS)
    harness_without = build_harness(Path(str(tmp_path) + "-2"), domain=without_ops)
    _with_fixed_spec(harness_without, SPEC_WITH_ACTIONS)

    body_with = harness_with.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()
    body_without = harness_without.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()

    spec_with = UISpec.model_validate(body_with["spec"])
    spec_without = UISpec.model_validate(body_without["spec"])
    assert compute_spec_hash(spec_with) == compute_spec_hash(spec_without)


def test_degrades_gracefully_when_list_operations_raises(tmp_path: Path) -> None:
    class _FailingDomain:
        async def list_operations(self) -> list[OperationDescriptor]:
            raise RuntimeError("domain unavailable (test)")

        async def invoke(self, op: str, args: Any, ctx: Any) -> object:
            return {"ok": True, "op": op, "args": args}

    seen: list[str] = []
    harness = build_harness(
        tmp_path, domain=_FailingDomain(), on_error=lambda info: seen.append(info.endpoint)
    )
    _with_fixed_spec(harness, SPEC_WITH_ACTIONS)
    res = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    assert "actions" not in res.json()
    assert "compose" in seen


def test_present_on_events_response(tmp_path: Path) -> None:
    domain = _domain_with(OperationDescriptor(name="annotate", description="d", tier="confirm"))
    harness = build_harness(tmp_path, domain=domain)
    _with_fixed_spec(harness, SPEC_WITH_ACTIONS)
    res = harness.client.post(
        _url("/events"),
        json={"intent": INTENT_BODY, "event": {"on": "root.publishClick", "payload": {}}},
    )
    assert res.status_code == 200
    assert res.json()["actions"] == {"annotate": {"tier": "confirm"}}


def test_present_on_compose_stream_event_spec_payload(tmp_path: Path) -> None:
    import json as _json_mod

    domain = _domain_with(
        OperationDescriptor(name="annotate", description="d", tier="confirm"),
        OperationDescriptor(name="publish", description="d"),
    )
    harness = build_harness(tmp_path, domain=domain)
    _with_fixed_spec(harness, SPEC_WITH_ACTIONS)
    res = harness.client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    block = next(b for b in res.text.split("\n\n") if "event: spec" in b)
    data_line = next(line for line in block.split("\n") if line.startswith("data:"))
    payload = _json_mod.loads(data_line[len("data:") :].strip())
    assert payload["actions"] == {"annotate": {"tier": "confirm"}, "publish": {"tier": "auto"}}
