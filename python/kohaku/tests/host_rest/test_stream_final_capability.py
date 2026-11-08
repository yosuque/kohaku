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
