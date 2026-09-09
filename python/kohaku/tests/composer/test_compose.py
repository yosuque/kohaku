"""Integration tests for the compose body (using FakeLlm — no real LLM is called).

A pytest port of the main scenarios of the TS-side packages/composer/test/compose.test.ts / budget.test.ts /
l2-repair.test.ts.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import replace
from typing import Any

import pytest

from kohaku.composer import (
    ComposeBudget,
    ComposeContext,
    ComposeErrorContext,
    ComposeObserver,
    ComposeOptions,
    ComposePolicy,
    IntentComposeInput,
    RecomposePatch,
    compose,
    compose_stream,
    create_l2_js_sidecar,
    recompose,
)
from kohaku.composer.compose_stream import (
    StreamDoneEvent,
    StreamPatchEvent,
    StreamSpecEvent,
)
from kohaku.composer.context import L2SmokeContext
from kohaku.llm import FakeLlm, LlmError, LlmPort
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    DataShape,
    Intent,
    IntentInput,
    QueryHandle,
    SessionContext,
    UISpec,
    apply_patch,
    canonical_stringify,
)
from kohaku.storage import FileStoragePort

_CATALOG = resolve_catalog(core_catalog())
_REF = "query://sales/summary?fy=2026"


class _FakeSemantic:
    """SemanticPort for tests (deterministic)."""

    def __init__(self, data_version: str = "v1") -> None:
        self._data_version = data_version

    async def normalize(self, input: Any, ctx: SessionContext) -> IntentInput:
        return IntentInput(canonical="sales.summary", params={"fy": 2026})

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return QueryHandle(uri=_REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return self._data_version

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        return DataShape.model_validate(
            {
                "columns": [
                    {"name": "region", "type": "string", "role": "dimension"},
                    {"name": "revenue", "type": "number", "role": "measure"},
                ]
            }
        )


def _l1_draft() -> dict[str, Any]:
    """A generation-schema-conforming L1 draft (payload is a pair array)."""
    return {
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["h", "t"]},
            {"id": "h", "type": "text.heading", "props": {"level": 2, "text": "Sales summary"}},
            {
                "id": "t",
                "type": "presentSpreadsheet",
                "props": {},
                "data": {"$ref": _REF},
            },
        ],
        "events": [
            {
                "on": "t.rowClick",
                "emit": "intent.patch",
                "payload": [{"key": "region", "value": "$row.region"}],
            }
        ],
    }


_L2_HTML = (
    "<!DOCTYPE html><html><head><title>Custom</title></head><body><div id=x></div>"
    "<script>window.kohaku.fetchData('" + _REF + "').then(function(d){"
    "document.getElementById('x').textContent=d.rows.length;window.kohaku.ready();});"
    "</script></body></html>"
)


def _ctx(
    llm: LlmPort, storage: FileStoragePort, policy: ComposePolicy | None = None, **kwargs: Any
) -> ComposeContext:
    return ComposeContext(
        catalog=_CATALOG,
        semantic=_FakeSemantic(),
        storage=storage,
        llm=llm,
        policy=policy,
        **kwargs,
    )


_INTENT_INPUT = IntentComposeInput(intent=IntentInput(canonical="sales.summary", params={"fy": 2026}))


class TestComposeL1:
    def test_l1_happy_path_and_cache_hit(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage)

            first = await compose(_INTENT_INPUT, ctx)
            assert first.spec.provenance.tier == "L1"
            assert first.spec.provenance.cache == "miss"
            assert first.trace.cache == "miss"
            # Deterministic post-processing: IDs are normalized to prefix + sequence number, and event references follow
            assert [c.id for c in first.spec.components] == ["root", "title1", "table1"]
            assert first.spec.events[0].on == "table1.rowClick"
            # Default sort (descending by measure) filled in
            table = next(c for c in first.spec.components if c.type == "presentSpreadsheet")
            assert table.props["sortBy"] == {"field": "revenue", "dir": "desc"}
            # refVersions filled in
            assert first.spec.refVersions == {_REF: "v1"}

            # The second time is a cache hit (no additional LLM call; identical components = determinism)
            second = await compose(_INTENT_INPUT, ctx)
            assert second.spec.provenance.cache == "hit"
            assert second.trace.cache == "hit"
            assert canonical_stringify([c.to_wire() for c in second.spec.components]) == (
                canonical_stringify([c.to_wire() for c in first.spec.components])
            )
            assert len([c for c in llm.calls if c.kind == "object"]) == 1

        asyncio.run(run())

    def test_l1_repair_loop(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            bad = {"components": [{"id": "root", "type": "no.such", "props": {}}], "events": []}
            llm = FakeLlm(objects=[bad, _l1_draft()])
            ctx = _ctx(llm, storage)

            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L1"
            assert result.spec.provenance.fallback is None
            assert len(result.trace.attempts) == 2
            assert result.trace.attempts[0].ok is False
            # The repair prompt carries the previous issues
            assert "Problems in the previous generation" in llm.calls[1].prompt

        asyncio.run(run())

    def test_l1_exhausted_falls_back_and_not_cached(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            bad = {"components": [{"id": "root", "type": "no.such", "props": {}}], "events": []}
            errors: list[ComposeErrorContext] = []
            observer = ComposeObserver(onError=lambda c, e: errors.append(c))
            llm = FakeLlm(objects=[bad, bad])
            ctx = _ctx(llm, storage, observer=observer)

            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L1"
            fb = result.spec.provenance.fallback
            assert fb is not None and fb.kind == "generation"
            # The fallback Spec is not cached (generation runs again next time)
            assert await storage.get_spec_cache(result.trace.cacheKey) is None
            # The observer hook is notified of the fallback once
            await asyncio.sleep(0)  # synchronous flush of fire-and-forget
            assert len(errors) == 1 and errors[0].phase == "fallback" and errors[0].tier == "L1"

        asyncio.run(run())

    def test_transient_failure_skips_l2(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)

            def _raise(req: Any) -> Any:
                raise LlmError("PROVIDER", "upstream 500")

            llm = FakeLlm(objects=_raise, texts=[_L2_HTML])
            ctx = _ctx(llm, storage, policy=ComposePolicy(allowL2=True))

            result = await compose(_INTENT_INPUT, ctx)
            fb = result.spec.provenance.fallback
            assert fb is not None and "transient error" in fb.reason
            # L2 (generate_text) is not called
            assert all(c.kind != "text" for c in llm.calls)

        asyncio.run(run())


class TestComposeL2:
    def test_route_l2_generates_sandbox_artifact(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(texts=[_L2_HTML])
            ctx = _ctx(
                llm,
                storage,
                policy=ComposePolicy(allowL2=True, routeTier=lambda _i: "L2"),
            )

            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L2"
            sandbox = next(c for c in result.spec.components if c.type == "sandbox.html")
            assert sandbox.artifact is not None and sandbox.artifact.inline == _L2_HTML
            assert sandbox.data is not None and sandbox.data.ref == _REF
            title = next(c for c in result.spec.components if c.type == "text.heading")
            assert title.props["text"] == "Custom"

        asyncio.run(run())

    def test_l2_lint_repair(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            broken = _L2_HTML.replace("window.kohaku.ready();", "window.kohaku.onReady();")
            llm = FakeLlm(texts=[broken, _L2_HTML])
            ctx = _ctx(
                llm, storage, policy=ComposePolicy(allowL2=True, routeTier=lambda _i: "L2")
            )

            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L2"
            assert len(result.trace.attempts) == 2
            assert any("L2_UNKNOWN_API" in i for i in result.trace.attempts[0].issues or [])
            # The lint findings are sent back into the repair prompt
            assert "Problems in the previous generation" in llm.calls[1].prompt

        asyncio.run(run())

    def test_l1_invalid_escalates_to_l2(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            bad = {"components": [{"id": "root", "type": "no.such", "props": {}}], "events": []}
            llm = FakeLlm(objects=[bad, bad], texts=[_L2_HTML])
            ctx = _ctx(llm, storage, policy=ComposePolicy(allowL2=True))

            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L2"
            assert result.spec.provenance.fallback is None

        asyncio.run(run())

    def test_l2_script_syntax_repair_via_sidecar(self, tmp_path: Any) -> None:
        """Wiring l2ScriptSyntax (the JS sidecar) sends syntax-error HTML back into the repair loop.

        HTML that passes the lexical lint (collect_l2_issues) but contains a JS syntax error → the injected
        syntax check returns L2_SCRIPT_SYNTAX and the repair retry converges to valid HTML (the symmetrization
        when Node is co-located; Task #39). Skipped in environments where Node/CLI is not co-located.
        """
        sidecar = create_l2_js_sidecar(ready_timeout_ms=300, timeout_s=30.0)
        # When the Node sidecar is required (e.g. in CI), forbid a silent skip (fail if not detected).
        # A guard of the same shape as test_l2_js_sidecar.py. When REQUIRE_NODE is unset, skip as before.
        require_node = os.environ.get("KOHAKU_REQUIRE_NODE_SIDECAR", "") == "1"
        if not sidecar.is_available():
            if require_node:
                raise RuntimeError(
                    "KOHAKU_REQUIRE_NODE_SIDECAR=1 but the Node/CLI sidecar is unavailable"
                    f"(cli={sidecar.cli_path!r})"
                )
            pytest.skip("skipped because Node/CLI is not co-located")

        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            # Mix an unterminated string literal (containing a raw newline) into the start of the script = a JS
            # syntax error. Because it uses only ready() / </html> / known APIs, it touches no lexical lint and only the syntax check sends it back.
            broken = _L2_HTML.replace(
                "<script>window.kohaku.fetchData",
                "<script>var s = '<div>\nunterminated;\nwindow.kohaku.fetchData",
            )
            llm = FakeLlm(texts=[broken, _L2_HTML])
            ctx = _ctx(
                llm,
                storage,
                policy=ComposePolicy(
                    allowL2=True, routeTier=lambda _i: "L2", l2ScriptSyntax=sidecar.lint
                ),
            )

            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L2"
            assert len(result.trace.attempts) == 2
            assert any(
                "L2_SCRIPT_SYNTAX" in i for i in result.trace.attempts[0].issues or []
            )

        asyncio.run(run())


class TestBudget:
    def test_zero_budget_skips_all_llm(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            errors: list[ComposeErrorContext] = []
            ctx = _ctx(
                llm,
                storage,
                policy=ComposePolicy(
                    budget=ComposeBudget(per_compose_stop_after_tokens=0), allowL2=True
                ),
                observer=ComposeObserver(onError=lambda c, e: errors.append(c)),
            )

            result = await compose(_INTENT_INPUT, ctx)
            fb = result.spec.provenance.fallback
            assert fb is not None and "budget exceeded" in fb.reason.lower()
            assert llm.calls == []  # the LLM is never called
            await asyncio.sleep(0)
            assert errors[0].budgetExceeded is True

        asyncio.run(run())

    def test_check_hook_rejection(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.composer import BudgetVerdict

            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(
                llm,
                storage,
                policy=ComposePolicy(
                    budget=ComposeBudget(
                        check=lambda: BudgetVerdict(allow=False, reason="daily budget exceeded")
                    )
                ),
            )
            result = await compose(_INTENT_INPUT, ctx)
            fb = result.spec.provenance.fallback
            assert fb is not None and fb.reason == "daily budget exceeded"

        asyncio.run(run())

    def test_check_hook_throw_is_fail_open(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])

            def _broken() -> Any:
                raise RuntimeError("budget store connection failed")

            ctx = _ctx(
                llm, storage, policy=ComposePolicy(budget=ComposeBudget(check=_broken))
            )
            result = await compose(_INTENT_INPUT, ctx)
            # fail-open: generation continues and a normal Spec is returned
            assert result.spec.provenance.fallback is None

        asyncio.run(run())


class TestL0AndSingleFlight:
    def test_fixed_specs_short_circuit(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.spec import UISpec

            storage = FileStoragePort(tmp_path)
            template = UISpec.model_validate(
                {
                    "kohaku": "0.2",
                    "intent": {"canonical": "x.y", "params": {}, "hash": "sha256:" + "0" * 64},
                    "dataVersion": "ignored",
                    "components": [
                        {"id": "root", "type": "layout.stack", "props": {}, "children": ["m"]},
                        {"id": "m", "type": "presentMarkdown", "props": {"markdown": "pinned"}},
                    ],
                    "provenance": {"tier": "L0", "composedBy": "t", "cache": "miss"},
                }
            )

            class _Fixed:
                async def lookup(self, intent: Intent) -> Any:
                    return template

            llm = FakeLlm()
            ctx = _ctx(llm, storage, policy=ComposePolicy(fixedSpecs=_Fixed()))
            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L0"
            assert llm.calls == []
            # L0 is cached
            assert await storage.get_spec_cache(result.trace.cacheKey) is not None

        asyncio.run(run())

    def test_single_flight_coalesces_concurrent_composes(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            started = asyncio.Event()
            release = asyncio.Event()
            call_count = 0

            def _slow(req: Any) -> Any:
                nonlocal call_count
                call_count += 1
                return _l1_draft()

            llm = FakeLlm(objects=_slow)

            class _SlowSemantic(_FakeSemantic):
                async def data_version(self, handle: QueryHandle) -> str:
                    return "v1"

            ctx = ComposeContext(
                catalog=_CATALOG, semantic=_SlowSemantic(), storage=storage, llm=llm
            )

            # Wrap generate_object to delay the LLM
            original = llm.generate_object

            async def _gated(req: Any) -> Any:
                started.set()
                await release.wait()
                return await original(req)

            llm.generate_object = _gated  # type: ignore[method-assign]

            # Deterministically observe that task2 joined the in-flight entry as a follower (waiters==2).
            # sleep(0) just spins the event loop once; what we wait for is an "observable state (the join)", not
            # wall-clock time (removing the timing dependence of the old sleep(0.01)). Releasing before the join
            # could make task2 a new leader, so release only after confirming the join.
            from kohaku.composer.compose import _inflight_map

            async def _await_followers(expected: int) -> None:
                table = _inflight_map(storage)
                for _ in range(10_000):
                    entry = next(iter(table.values()), None)
                    if entry is not None and entry.waiters >= expected:
                        return
                    await asyncio.sleep(0)
                raise AssertionError("follower did not join the in-flight entry")

            task1 = asyncio.create_task(compose(_INTENT_INPUT, ctx))
            await started.wait()
            task2 = asyncio.create_task(compose(_INTENT_INPUT, ctx))
            await _await_followers(2)
            release.set()
            r1, r2 = await asyncio.gather(task1, task2)

            assert call_count == 1  # generation is folded into one
            leader, follower = (r1, r2) if not r1.trace.coalesced else (r2, r1)
            assert follower.trace.coalesced is True
            assert follower.trace.cache == "hit"
            assert follower.trace.attempts == []
            assert canonical_stringify([c.to_wire() for c in follower.spec.components]) == (
                canonical_stringify([c.to_wire() for c in leader.spec.components])
            )

        asyncio.run(run())

    def _voting_harness(
        self, storage: Any
    ) -> tuple[Any, asyncio.Event, asyncio.Event, Any]:
        """Shared harness for the abort-voting tests (a gated, abort-respecting LLM + ctx).

        Returns (ctx, started, release, call_count_getter). The LLM throws ABORTED if req.abort is expired,
        otherwise returns an L1 draft (reproducing the adapter's abort-respecting behavior).
        """
        started = asyncio.Event()
        release = asyncio.Event()
        call_count = 0

        def _respect_abort(req: Any) -> Any:
            nonlocal call_count
            call_count += 1
            if req.abort is not None and req.abort.aborted:
                raise LlmError("ABORTED", "aborted")
            return _l1_draft()

        llm = FakeLlm(objects=_respect_abort)
        ctx = ComposeContext(
            catalog=_CATALOG, semantic=_FakeSemantic(), storage=storage, llm=llm
        )
        original = llm.generate_object

        async def _gated(req: Any) -> Any:
            started.set()
            await release.wait()
            return await original(req)

        llm.generate_object = _gated  # type: ignore[method-assign]
        return ctx, started, release, (lambda: call_count)

    async def _await_followers(self, storage: Any, expected: int) -> None:
        from kohaku.composer.compose import _inflight_map

        table = _inflight_map(storage)
        for _ in range(10_000):
            entry = next(iter(table.values()), None)
            if entry is not None and entry.waiters >= expected:
                return
            await asyncio.sleep(0)
        raise AssertionError("follower did not join the in-flight entry")

    def test_leader_abort_does_not_propagate_to_healthy_follower(self, tmp_path: Any) -> None:
        """Even if only the leader aborts, the shared generation continues as long as a healthy follower remains (the voting scheme)."""

        async def run() -> None:
            from kohaku.llm import AbortController

            storage = FileStoragePort(tmp_path)
            ctx, started, release, call_count = self._voting_harness(storage)
            leader_ctrl = AbortController()
            follower_ctrl = AbortController()

            task_leader = asyncio.create_task(
                compose(_INTENT_INPUT, ctx, ComposeOptions(abort=leader_ctrl.signal))
            )
            await started.wait()
            task_follower = asyncio.create_task(
                compose(_INTENT_INPUT, ctx, ComposeOptions(abort=follower_ctrl.signal))
            )
            await self._await_followers(storage, 2)
            # Only the leader aborts — a follower remains (waiters>0), so the shared controller does not expire.
            leader_ctrl.abort()
            release.set()
            r_leader, r_follower = await asyncio.gather(task_leader, task_follower)

            assert call_count() == 1  # generation runs once and completes normally (the abort does not reach the vote)
            assert r_leader.spec.provenance.fallback is None
            assert r_follower.spec.provenance.fallback is None

        asyncio.run(run())

    def test_all_participants_abort_stops_shared_generation(self, tmp_path: Any) -> None:
        """The shared generation is aborted and falls back only when all waiters abort (quorum 0)."""

        async def run() -> None:
            from kohaku.llm import AbortController

            storage = FileStoragePort(tmp_path)
            ctx, started, release, _ = self._voting_harness(storage)
            leader_ctrl = AbortController()
            follower_ctrl = AbortController()

            task_leader = asyncio.create_task(
                compose(_INTENT_INPUT, ctx, ComposeOptions(abort=leader_ctrl.signal))
            )
            await started.wait()
            task_follower = asyncio.create_task(
                compose(_INTENT_INPUT, ctx, ComposeOptions(abort=follower_ctrl.signal))
            )
            await self._await_followers(storage, 2)
            # Everyone aborts → waiters==0 → the shared controller expires → the LLM throws ABORTED → fallback.
            leader_ctrl.abort()
            follower_ctrl.abort()
            release.set()
            r_leader, r_follower = await asyncio.gather(task_leader, task_follower)

            assert r_leader.spec.provenance.fallback is not None
            assert r_follower.spec.provenance.fallback is not None
            # Both are marked cancelled (not a generation failure): the follower copies it from the
            # leader's trace, so hosts exclude both from the fallback-rate analytics.
            assert r_leader.trace.cancelled is True
            assert r_follower.trace.cancelled is True

        asyncio.run(run())


class TestComposeStream:
    def test_slow_path_yields_skeleton_then_patch(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage)

            events = [e async for e in compose_stream(_INTENT_INPUT, ctx)]
            assert [e.kind for e in events] == ["spec", "patch", "done"]
            skeleton_event = events[0]
            assert isinstance(skeleton_event, StreamSpecEvent)
            assert skeleton_event.final is False
            assert any(c.type == "ui.loading" for c in skeleton_event.spec.components)
            patch_event = events[1]
            assert isinstance(patch_event, StreamPatchEvent)
            done_event = events[2]
            assert isinstance(done_event, StreamDoneEvent)
            # patch-applied spec = the final form
            from kohaku.spec import apply_patch

            applied = apply_patch(skeleton_event.spec, patch_event.patch)
            assert canonical_stringify(applied.to_wire()) == canonical_stringify(
                done_event.result.spec.to_wire()
            )
            # The skeleton is not cached (only the final form is cached)
            cached = await storage.get_spec_cache(done_event.result.trace.cacheKey)
            assert cached is not None
            assert all(c.type != "ui.loading" for c in cached.components)

        asyncio.run(run())

    def test_cache_hit_is_single_final_event(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage)
            await compose(_INTENT_INPUT, ctx)  # warm the cache

            events = [e async for e in compose_stream(_INTENT_INPUT, ctx)]
            assert [e.kind for e in events] == ["spec", "done"]
            first = events[0]
            assert isinstance(first, StreamSpecEvent) and first.final is True

        asyncio.run(run())


def _partial_sequence() -> list[Any]:
    """Cumulative partial sequence of _l1_draft (mimics the LLM's partial output; each element is the cumulative form up to that point)."""
    full = _l1_draft()
    comps = full["components"]  # [root, heading, spreadsheet]
    return [
        # 1: root only (zero real components) → no provisional is emitted (the guard)
        {"components": [comps[0]], "events": []},
        # 2: root + heading (complete) + an in-progress chart (missing props) → a provisional with only the heading
        {
            "components": [
                comps[0],
                comps[1],
                {"id": "c", "type": "presentChart", "props": {"kind": "bar"}},
            ],
            "events": [],
        },
        # 3: root + heading + table (complete) → a provisional with all components
        {"components": [comps[0], comps[1], comps[2]], "events": []},
    ]


class TestComposeStreamProvisional:
    """Incremental streaming (stream_object partial → provisional patch). Equivalent to TS compose-stream.test.ts."""

    def test_provisional_patches_fold_and_converge(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()], partials=[_partial_sequence()])
            events = [e async for e in compose_stream(_INTENT_INPUT, _ctx(llm, storage))]

            assert events[0].kind == "spec"
            assert events[-1].kind == "done"
            patches = [e for e in events if isinstance(e, StreamPatchEvent)]
            # At least one provisional + one final.
            assert len(patches) >= 2

            # REST-STR-002 equivalent: folding apply_patch in receive order matches each patch.spec, and the final matches done.
            first = events[0]
            assert isinstance(first, StreamSpecEvent)
            folded = first.spec
            for p in patches:
                folded = apply_patch(folded, p.patch)
                assert canonical_stringify(folded.to_wire()) == canonical_stringify(p.spec.to_wire())
            done = events[-1]
            assert isinstance(done, StreamDoneEvent)
            assert canonical_stringify(folded.to_wire()) == canonical_stringify(
                done.result.spec.to_wire()
            )

            # No skeleton ui.loading remains in the provisional patches, and the component count is monotonically non-decreasing toward the final form.
            specs = [p.spec for p in patches]
            assert all(not any(c.type == "ui.loading" for c in s.components) for s in specs)
            counts = [len(s.components) for s in specs]
            assert sorted(counts) == counts

        asyncio.run(run())

    def test_final_form_byte_matches_non_stream_compose(self, tmp_path: Any) -> None:
        async def run() -> None:
            composed = await compose(_INTENT_INPUT, _ctx(FakeLlm(objects=[_l1_draft()]), FileStoragePort(tmp_path / "a")))
            events = [
                e
                async for e in compose_stream(
                    _INTENT_INPUT,
                    _ctx(
                        FakeLlm(objects=[_l1_draft()], partials=[_partial_sequence()]),
                        FileStoragePort(tmp_path / "b"),
                    ),
                )
            ]
            done = events[-1]
            assert isinstance(done, StreamDoneEvent)
            # The final form is byte-identical to non-stream compose (partials do not affect the final result).
            assert canonical_stringify(done.result.spec.to_wire()) == canonical_stringify(
                composed.spec.to_wire()
            )

        asyncio.run(run())

    def test_provisional_specs_are_not_cached(self, tmp_path: Any) -> None:
        async def run() -> None:
            base = FileStoragePort(tmp_path)
            persisted: list[UISpec] = []
            original_put = base.put_spec_cache

            async def _spy(key: str, spec: UISpec, *, ttl_seconds: int | None = None) -> None:
                persisted.append(spec)
                await original_put(key, spec, ttl_seconds=ttl_seconds)

            base.put_spec_cache = _spy  # type: ignore[method-assign]
            llm = FakeLlm(objects=[_l1_draft()], partials=[_partial_sequence()])
            events = [e async for e in compose_stream(_INTENT_INPUT, _ctx(llm, base))]
            assert len([e for e in events if isinstance(e, StreamPatchEvent)]) >= 2
            # Only the final Spec is cache-stored once (provisionals and the skeleton are not stored).
            assert len(persisted) == 1
            assert not any(c.type == "ui.loading" for c in persisted[0].components)

        asyncio.run(run())

    def test_unhealable_partials_are_skipped(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            comps = _l1_draft()["components"]
            llm = FakeLlm(
                objects=[_l1_draft()],
                partials=[
                    [
                        "garbage",  # cannot decode
                        {  # root not yet arrived (only the heading)
                            "components": [
                                {"id": "h", "type": "text.heading", "props": {"level": 2, "text": "x"}}
                            ],
                            "events": [],
                        },
                        {"components": [comps[0]], "events": []},  # root only (zero real components)
                    ]
                ],
            )
            events = [e async for e in compose_stream(_INTENT_INPUT, _ctx(llm, storage))]
            # All provisionals are skipped, leaving just the one final patch as before.
            assert [e.kind for e in events] == ["spec", "patch", "done"]

        asyncio.run(run())


class TestL2Smoke:
    """Wiring of the pre-delivery L2 smoke-verification hook (ComposePolicy.l2Smoke). Same shape as the TS l2-generate wiring."""

    def _l2_ctx(
        self, storage: FileStoragePort, l2_smoke: Any, texts: list[str]
    ) -> ComposeContext:
        return _ctx(
            FakeLlm(texts=texts),
            storage,
            policy=ComposePolicy(allowL2=True, routeTier=lambda _i: "L2", l2Smoke=l2_smoke),
        )

    def test_smoke_issues_trigger_repair(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            calls: list[L2SmokeContext] = []

            async def smoke(html: str, sctx: L2SmokeContext) -> list[str]:
                calls.append(sctx)
                # First a non-empty issue (send back for repair), then pass after repair.
                return ["SMOKE_FAILED: ready not reached"] if len(calls) == 1 else []

            ctx = self._l2_ctx(storage, smoke, [_L2_HTML, _L2_HTML])
            result = await compose(_INTENT_INPUT, ctx)
            assert result.spec.provenance.tier == "L2"
            assert result.spec.provenance.fallback is None
            # Smoke is called twice (first fails → repair → passes), and ctx carries the primaryRef.
            assert len(calls) == 2
            assert calls[0].ref == _REF

        asyncio.run(run())

    def test_smoke_exception_is_fail_open(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)

            async def smoke(html: str, sctx: L2SmokeContext) -> list[str]:
                raise RuntimeError("validator failure")

            ctx = self._l2_ctx(storage, smoke, [_L2_HTML])
            result = await compose(_INTENT_INPUT, ctx)
            # The throw is swallowed and the static-lint-passing L2 is delivered as-is (succeeds on the first attempt = no repair).
            assert result.spec.provenance.tier == "L2"
            assert result.spec.provenance.fallback is None

        asyncio.run(run())

    def test_unwired_smoke_is_unchanged(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            ctx = _ctx(
                FakeLlm(texts=[_L2_HTML]),
                storage,
                policy=ComposePolicy(allowL2=True, routeTier=lambda _i: "L2"),
            )
            result = await compose(_INTENT_INPUT, ctx)
            # When l2Smoke is unwired, deliver immediately on static-lint pass as before.
            assert result.spec.provenance.tier == "L2"

        asyncio.run(run())


class TestRecompose:
    def test_recompose_merges_params_and_returns_patch(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft(), _l1_draft()])
            ctx = _ctx(llm, storage)

            first = await compose(_INTENT_INPUT, ctx)
            result, patch = await recompose(
                first.spec, RecomposePatch(params={"region": "us"}), ctx
            )
            assert result.spec.intent.params == {"fy": 2026, "region": "us"}
            assert patch.baseIntentHash == first.spec.intent.hash

        asyncio.run(run())

    def test_recompose_respects_prev_tier_with_policy_for(self, tmp_path: Any) -> None:
        """respect_prev_tier's L2 pin must survive even when ctx.policyFor is wired and resolves its
        own (L1-default) session policy — mirrors the TS test of the same intent in compose.test.ts."""

        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(texts=[_L2_HTML, _L2_HTML])
            ctx = _ctx(
                llm,
                storage,
                policy=ComposePolicy(allowL2=True, routeTier=lambda _i: "L2"),
                policyFor=lambda _session: ComposePolicy(
                    allowL2=True, generatorVersion="session-policy-v1"
                ),
            )

            first = await compose(_INTENT_INPUT, ctx)
            assert first.spec.provenance.tier == "L2"

            result, _patch = await recompose(
                first.spec,
                RecomposePatch(params={"region": "us"}),
                ctx,
                respect_prev_tier=True,
            )

            # Still routed to L2 despite policyFor resolving its own (L1-default) session policy.
            assert result.spec.provenance.tier == "L2"
            assert len([c for c in llm.calls if c.kind == "text"]) == 2
            # The session policy's generatorVersion survives (only routeTier/allowL2 are overridden).
            assert result.trace.cacheKey.endswith(":session-policy-v1")

        asyncio.run(run())


class _ThrowingGetStorage(FileStoragePort):
    """A FileStoragePort whose get_spec_cache always raises (simulates a cache-backend outage)."""

    async def get_spec_cache(self, key: str) -> UISpec | None:
        raise RuntimeError("cache backend unavailable(test)")


class _ThrowingPutStorage(FileStoragePort):
    """A FileStoragePort whose put_spec_cache always raises (simulates a cache-backend outage)."""

    async def put_spec_cache(self, key: str, spec: UISpec, *, ttl_seconds: int | None = None) -> None:
        raise RuntimeError("cache backend unavailable(test)")


class TestSpecCacheFailOpen:
    """Mirrors the TS "compose: Spec cache fail-open (cacheFailure policy)" describe block."""

    def test_get_spec_cache_throwing_is_treated_as_a_miss(self, tmp_path: Any) -> None:
        async def run() -> None:
            captured: list[tuple[ComposeErrorContext, BaseException | None]] = []
            storage = _ThrowingGetStorage(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(
                llm,
                storage,
                observer=ComposeObserver(
                    onError=lambda c, error: captured.append((c, error))
                ),
            )

            result = await compose(_INTENT_INPUT, ctx)

            assert result.spec.provenance.fallback is None
            assert result.trace.cache == "miss"
            assert len(captured) == 1
            assert captured[0][0].phase == "cache"
            assert isinstance(captured[0][1], Exception)

        asyncio.run(run())

    def test_put_spec_cache_throwing_does_not_block_delivery(self, tmp_path: Any) -> None:
        async def run() -> None:
            captured: list[tuple[ComposeErrorContext, BaseException | None]] = []
            storage = _ThrowingPutStorage(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(
                llm,
                storage,
                observer=ComposeObserver(
                    onError=lambda c, error: captured.append((c, error))
                ),
            )

            result = await compose(_INTENT_INPUT, ctx)

            assert result.spec.provenance.fallback is None
            assert len(captured) == 1
            assert captured[0][0].phase == "cache"

        asyncio.run(run())

    def test_cache_failure_closed_reraises_the_storage_error(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = _ThrowingGetStorage(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage, policy=ComposePolicy(cacheFailure="closed"))

            with pytest.raises(RuntimeError, match="cache backend unavailable"):
                await compose(_INTENT_INPUT, ctx)

        asyncio.run(run())


class TestAbortPropagation:
    def test_aborted_signal_falls_back_without_repair(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.llm import AbortController

            storage = FileStoragePort(tmp_path)
            controller = AbortController()

            def _respect_abort(req: Any) -> Any:
                # Respect abort like the adapter (FakeLlm does not look at it, so reproduce it on the script side)
                if req.abort is not None and req.abort.aborted:
                    raise LlmError("ABORTED", "aborted")
                return _l1_draft()

            llm = FakeLlm(objects=_respect_abort)
            ctx = _ctx(llm, storage, policy=ComposePolicy(allowL2=True))
            controller.abort()

            captured: list[ComposeErrorContext] = []
            ctx = replace(
                ctx,
                observer=ComposeObserver(onError=lambda c, _e: captured.append(c)),
            )

            result = await compose(
                _INTENT_INPUT, ctx, ComposeOptions(abort=controller.signal)
            )
            fb = result.spec.provenance.fallback
            assert fb is not None  # ABORTED → immediate fallback without repair or L2
            assert len([c for c in llm.calls if c.kind == "object"]) == 1
            # ABORTED is classified separately from a transient provider failure: the trace is marked
            # cancelled and the observer sees phase "cancelled" rather than "fallback", so hosts do not
            # count an abandoned request against the generation-fallback rate.
            assert result.trace.cancelled is True
            assert len(captured) == 1
            assert captured[0].phase == "cancelled"

        asyncio.run(run())
