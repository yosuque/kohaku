"""Tests for record_view_fallback (port of packages/host-core/src/view-recorder.ts).

TS host-core has no dedicated view-recorder.test.ts of its own — recordViewFallback is exercised indirectly
through packages/host-mcp-apps/test/mcp.test.ts's "kohaku_compose records composed + fallback" case (kind
defaulting/propagation) and packages/host-rest/test/analytics.test.ts's fallback-summary case (which exercises
the caller's own aggregation, not this function). These cases mirror the concrete behavior documented in
recordViewFallback's own doc comment: the judgment source is spec.provenance.fallback (not the compose
trace, since capability-negotiation downgrade can recur on a cache hit), and a missing `kind` defaults to
"generation".
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from kohaku.host_core.view_recorder import record_view_fallback
from kohaku.spec import (
    ComponentNode,
    Intent,
    IntentInput,
    Provenance,
    ProvenanceFallback,
    UISpec,
    finalize_intent,
)

INTENT: Intent = finalize_intent(IntentInput(canonical="sales.trend", params={}))


def _spec(fallback: ProvenanceFallback | None) -> UISpec:
    provenance = (
        Provenance(tier="L1", composedBy="fixture", cache="miss")
        if fallback is None
        else Provenance(tier="L1", composedBy="fixture", cache="miss", fallback=fallback)
    )
    return UISpec(
        kohaku="0.1",
        intent=INTENT,
        dataVersion="v1",
        components=[ComponentNode(id="root", type="sandbox.html", props={"html": "<div/>"})],
        events=[],
        provenance=provenance,
    )


@dataclass
class _FakeRecorder:
    """Structurally satisfies host_core.view_recorder's narrow fallback-only recorder protocol."""

    calls: list[dict[str, object]] = field(default_factory=list)

    async def fallback(
        self,
        *,
        spec: UISpec,
        reason: str,
        kind: str,
        surface: str,
        session_id: str | None = None,
        tenant: str | None = None,
    ) -> None:
        self.calls.append(
            {
                "spec": spec,
                "reason": reason,
                "kind": kind,
                "surface": surface,
                "session_id": session_id,
                "tenant": tenant,
            }
        )


def test_no_fallback_on_the_spec_does_not_call_recorder_fallback() -> None:
    recorder = _FakeRecorder()

    async def run() -> None:
        await record_view_fallback(recorder, _spec(None), surface="web")
        assert recorder.calls == []

    asyncio.run(run())


def test_a_fallback_with_an_explicit_kind_records_it_as_given() -> None:
    recorder = _FakeRecorder()
    fallback = ProvenanceFallback.model_validate(
        {"from": "L2", "reason": "generation exhausted", "kind": "negotiation"}
    )

    async def run() -> None:
        await record_view_fallback(
            recorder, _spec(fallback), surface="web", session_id="s1", tenant="acme"
        )
        assert len(recorder.calls) == 1
        call = recorder.calls[0]
        assert call["reason"] == "generation exhausted"
        assert call["kind"] == "negotiation"
        assert call["surface"] == "web"
        assert call["session_id"] == "s1"
        assert call["tenant"] == "acme"

    asyncio.run(run())


def test_a_fallback_with_no_kind_defaults_to_generation_compatible_with_older_records() -> None:
    recorder = _FakeRecorder()
    fallback = ProvenanceFallback.model_validate({"from": "L1", "reason": "llm failure"})

    async def run() -> None:
        await record_view_fallback(recorder, _spec(fallback), surface="mcp-app")
        assert len(recorder.calls) == 1
        assert recorder.calls[0]["kind"] == "generation"

    asyncio.run(run())


def test_recorder_none_is_a_no_op() -> None:
    fallback = ProvenanceFallback.model_validate(
        {"from": "L1", "reason": "llm failure", "kind": "generation"}
    )

    async def run() -> None:
        # Must not raise even though the spec has a fallback.
        await record_view_fallback(None, _spec(fallback), surface="web")

    asyncio.run(run())
