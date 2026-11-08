"""Port of packages/host-rest/test/stream-final-capability.test.ts.

With ComposePolicy.l1Filters the finalized L1 Spec carries data.bind variants that the skeleton's refs-based
capability does not cover. The generation path has no final `spec` event (skeleton -> patch* -> done), so the last
convergence patch carries a replacement `capability` issued from the finalized Spec.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from kohaku.composer import ComposePolicy
from kohaku.llm import FakeLlm
from kohaku.spec import FilterDescriptor, FilterOption, Intent

from .conftest import INTENT_BODY, PREFIX, REF, Harness, _l1_draft, build_harness
from .test_stream_patches import _read_sse

VARIANT = "query://sales/summary?fy=2025"

FY = FilterDescriptor(
    param="fy",
    queryParam="fy",
    paths=["summary"],
    label="Fiscal year",
    options=[FilterOption("2026", "FY2026"), FilterOption("2025", "FY2025")],
)


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


async def _describe_filters(
    intent: Intent, *, tenant: str | None = None, locale: str | None = None
) -> list[FilterDescriptor]:
    return [FY]


def _harness(tmp_path: Path, *, l1_filters: bool) -> tuple[Harness, FakeLlm]:
    harness = build_harness(tmp_path)
    llm = FakeLlm(objects=[_l1_draft()])
    # conftest's FakeSemantic does not implement the optional describe_filters; attach it for this test.
    harness.ctx.semantic.describe_filters = _describe_filters  # type: ignore[attr-defined]
    harness.deps.compose = replace(harness.ctx, llm=llm, policy=ComposePolicy(l1Filters=l1_filters))
    return harness, llm


def _resolve_status(harness: Harness, capability: str, ref: str) -> int:
    res = harness.client.get(
        _url("/binding/resolve"),
        params={"ref": ref},
        headers={"authorization": f"Bearer {capability}"},
    )
    return res.status_code


def test_the_last_patch_carries_a_capability_that_resolves_every_variant(tmp_path: Path) -> None:
    harness, llm = _harness(tmp_path, l1_filters=True)
    res = harness.client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    events = _read_sse(res.text)

    skeleton = json.loads(next(e for e in events if e["event"] == "spec")["data"])
    assert skeleton["final"] is False
    skeleton_cap = skeleton["capability"]
    assert _resolve_status(harness, skeleton_cap, REF) == 200
    # The skeleton's refs-based capability does not know the filter variants.
    assert _resolve_status(harness, skeleton_cap, VARIANT) == 403

    patches = [json.loads(e["data"]) for e in events if e["event"] == "patch"]
    with_cap = [p for p in patches if p.get("capability") is not None]
    assert len(with_cap) == 1
    assert patches[-1] is with_cap[-1]
    final_cap = with_cap[0]["capability"]
    assert _resolve_status(harness, final_cap, REF) == 200
    assert _resolve_status(harness, final_cap, VARIANT) == 200

    # Changing the filter costs no model call: a single L1 generation served the whole stream.
    assert len(llm.calls) == 1
    assert events[-1]["event"] == "done"
    # done's shape is unchanged (REST-STR-003).
    assert sorted(json.loads(events[-1]["data"]).keys()) == ["cache", "specHash", "tier"]


def test_without_l1_filters_no_patch_carries_a_capability(tmp_path: Path) -> None:
    harness, _ = _harness(tmp_path, l1_filters=False)
    res = harness.client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    patches: list[dict[str, Any]] = [
        json.loads(e["data"]) for e in _read_sse(res.text) if e["event"] == "patch"
    ]
    assert patches
    assert all("capability" not in p for p in patches)


def test_a_stream_cache_hit_delivers_a_final_spec_event_whose_capability_covers_the_variants(
    tmp_path: Path,
) -> None:
    harness, llm = _harness(tmp_path, l1_filters=True)
    harness.client.post(
        _url("/compose/stream"), json={"intent": INTENT_BODY}
    )  # miss: warms the cache
    res = harness.client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    events = _read_sse(res.text)
    first = json.loads(next(e for e in events if e["event"] == "spec")["data"])
    assert first["final"] is True
    assert _resolve_status(harness, first["capability"], VARIANT) == 200
    # No convergence patch is needed (nor sent with a capability) on the fast path.
    assert [e for e in events if e["event"] == "patch"] == []
    assert len(llm.calls) == 1


def test_a_fixated_injected_spec_is_delivered_unchanged_with_a_capability_for_its_variants(
    tmp_path: Path,
) -> None:
    harness, llm = _harness(tmp_path, l1_filters=True)
    composed = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    assert any(c["type"] == "control.select" for c in composed["components"])
    approve = harness.client.post(_url("/fixations/approve"), json={"intent": INTENT_BODY})
    assert approve.status_code == 200
    delivered = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()
    assert delivered["spec"]["provenance"]["cache"] == "fixated"
    assert delivered["spec"]["components"] == composed["components"]
    assert delivered["spec"]["state"] == composed["state"]
    assert _resolve_status(harness, delivered["capability"], VARIANT) == 200
    assert len(llm.calls) == 1


def test_a_fixated_l0_pinned_spec_is_delivered_exactly_as_pinned_with_l1_filters_on(
    tmp_path: Path,
) -> None:
    from kohaku.composer import FixedSpecSource
    from kohaku.spec import QueryHandle, UISpec

    class _Fixed(FixedSpecSource):
        async def lookup(self, intent: Intent) -> Any:
            def build(intent: Intent, handles: list[QueryHandle]) -> UISpec:
                return UISpec.model_validate(
                    {
                        "kohaku": "0.2",
                        "intent": intent.to_wire(),
                        "dataVersion": "template",
                        "components": [
                            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c"]},
                            {
                                "id": "c",
                                "type": "presentChart",
                                "props": {"kind": "bar", "x": "region", "y": "revenue"},
                                "data": {"$ref": handles[0].uri},
                            },
                        ],
                        "events": [],
                        "provenance": {
                            "tier": "L0",
                            "composedBy": "fixed-spec-template",
                            "cache": "miss",
                        },
                    }
                )

            return build

    harness = build_harness(tmp_path)
    harness.ctx.semantic.describe_filters = _describe_filters  # type: ignore[attr-defined]
    harness.deps.compose = replace(
        harness.ctx, policy=ComposePolicy(l1Filters=True, fixedSpecs=_Fixed())
    )
    composed = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    assert (
        harness.client.post(_url("/fixations/approve"), json={"intent": INTENT_BODY}).status_code
        == 200
    )
    delivered = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    assert delivered["provenance"]["cache"] == "fixated"
    assert [c["id"] for c in delivered["components"]] == [c["id"] for c in composed["components"]]
    assert not any(c["type"] == "control.select" for c in delivered["components"])
    assert "state" not in delivered


def test_the_convergence_patch_also_carries_the_actions_manifest_and_the_write_scopes(
    tmp_path: Path,
) -> None:
    harness, _ = _harness(tmp_path, l1_filters=True)
    form_draft = {
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["t", "f"]},
            {"id": "t", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": REF}},
            {
                "id": "f",
                "type": "presentForm",
                "props": {
                    "action": "annotate",
                    "fields": [{"name": "note", "type": "text", "label": "Note"}],
                },
            },
        ],
        "events": [
            {
                "on": "f.submit",
                "emit": "action.invoke",
                "payload": [{"key": "note", "value": "$value.note"}],
            }
        ],
    }
    harness.deps.compose = replace(harness.deps.compose, llm=FakeLlm(objects=[form_draft]))
    res = harness.client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    events = _read_sse(res.text)
    skeleton = json.loads(next(e for e in events if e["event"] == "spec")["data"])
    assert "actions" not in skeleton
    last = [json.loads(e["data"]) for e in events if e["event"] == "patch"][-1]
    assert isinstance(last.get("capability"), str)
    assert "actions" in last
    # The re-issued capability carries the write scope a non-stream compose of this Spec would issue.
    write = harness.client.post(
        _url("/binding/action"),
        json={"action": "annotate", "payload": {"note": "hi"}},
        headers={"authorization": f"Bearer {last['capability']}"},
    )
    assert write.status_code == 200
