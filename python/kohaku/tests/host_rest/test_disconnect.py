"""host_rest wiring test for client-disconnect abort propagation.

- _disconnect_abort fires and cleans up an AbortSignal via request.is_disconnected() polling
- compose_with_fixation threads abort into compose and, on abort, falls to the deterministic fallback
- Disconnecting via /compose (is_disconnected -> True) aborts LLM generation and returns a fallback Spec

To be timing-independent, poll_interval is injected, and the LLM is a FakeLlm that respects abort.
"""

from __future__ import annotations

import asyncio
import dataclasses
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_rest import HostErrorInfo, KohakuHostDeps, attach_kohaku_routes
from kohaku.host_rest._fastapi_routes import (
    _compose_stream_body,
    _disconnect_abort,
    compose_with_fixation,
)
from kohaku.lineage import Lineage, create_lineage, create_view_recorder
from kohaku.llm import AbortController, FakeLlm, LlmError
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import IntentInput, Principal, SessionContext, finalize_intent
from kohaku.storage import FileStoragePort

from .conftest import (
    INTENT_BODY,
    PREFIX,
    FakeAuthz,
    FakeDomain,
    FakeSemantic,
    _l1_draft,
    build_harness,
)


def _abort_respecting_llm() -> FakeLlm:
    """A FakeLlm that respects abort like the adapter (raises ABORTED if already aborted)."""

    def _fn(req: Any) -> Any:
        if req.abort is not None and req.abort.aborted:
            raise LlmError("ABORTED", "aborted")
        return _l1_draft()

    return FakeLlm(objects=_fn)


def _deps(tmp_path: Path, llm: FakeLlm) -> KohakuHostDeps:
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(catalog=catalog, semantic=FakeSemantic(), storage=storage, llm=llm)
    return KohakuHostDeps(
        compose=ctx, domain=FakeDomain(), authz=FakeAuthz(), query_source="sales"
    )


def _deps_with_recorder(tmp_path: Path, llm: FakeLlm) -> tuple[KohakuHostDeps, Lineage]:
    """Same as _deps but with a real ViewRecorder wired, so a test can assert nothing was recorded."""
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(catalog=catalog, semantic=FakeSemantic(), storage=storage, llm=llm)
    lineage = create_lineage(storage)
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        recorder=create_view_recorder(lineage),
    )
    return deps, lineage


class _FakeRequest:
    """A minimal Request double with only is_disconnected (the target of _disconnect_abort's monitoring)."""

    def __init__(self, disconnected: bool) -> None:
        self._disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self._disconnected


async def _wait_until_aborted(sig: Any, timeout: float = 1.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not sig.aborted and loop.time() < deadline:
        await asyncio.sleep(0.001)


def test_disconnect_abort_fires_on_disconnect() -> None:
    async def run() -> None:
        req: Any = _FakeRequest(True)
        async with _disconnect_abort(req, poll_interval_s=0.001) as sig:
            await _wait_until_aborted(sig)
            assert sig.aborted

    asyncio.run(run())


def test_disconnect_abort_stays_live_when_connected() -> None:
    async def run() -> None:
        req: Any = _FakeRequest(False)
        async with _disconnect_abort(req, poll_interval_s=0.001) as sig:
            await asyncio.sleep(0.02)
            assert not sig.aborted

    asyncio.run(run())


def test_disconnect_abort_cleans_up_monitor_task() -> None:
    """No monitor task remains after leaving the context (cleaned up even while the connection stays alive)."""

    async def run() -> None:
        req: Any = _FakeRequest(False)
        before = len(asyncio.all_tasks())
        async with _disconnect_abort(req, poll_interval_s=0.001):
            pass
        # Already cancelled right after leaving. Task reclamation is scheduler-dependent, so wait with bounded polling.
        deadline = asyncio.get_running_loop().time() + 1.0
        while len(asyncio.all_tasks()) > before:
            if asyncio.get_running_loop().time() >= deadline:
                break
            await asyncio.sleep(0.005)
        assert len(asyncio.all_tasks()) <= before

    asyncio.run(run())


def test_compose_with_fixation_threads_abort_to_fallback(tmp_path: Path) -> None:
    """Passing an already-aborted signal makes compose fall to ABORTED -> the deterministic fallback."""

    async def run() -> None:
        deps = _deps(tmp_path, _abort_respecting_llm())
        controller = AbortController()
        controller.abort()  # equivalent to a disconnect (= abort all waiters)
        intent = finalize_intent(IntentInput(canonical="sales.summary", params={"fy": 2026}))
        result = await compose_with_fixation(
            intent, SessionContext(surface="web"), deps, abort=controller.signal
        )
        assert result.spec.provenance.fallback is not None

    asyncio.run(run())


def test_compose_route_aborts_generation_on_disconnect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Disconnecting via /compose aborts LLM generation and returns a fallback Spec (end-to-end)."""
    # Treat every request as disconnected (the monitor task fires at the first await inside compose).
    async def _always_disconnected(_self: Request) -> bool:
        return True

    monkeypatch.setattr(Request, "is_disconnected", _always_disconnected)

    deps = _deps(tmp_path, _abort_respecting_llm())
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)

    res = client.post(f"{PREFIX}/compose", json={"intent": INTENT_BODY})
    assert res.status_code == 200
    spec = res.json()["spec"]
    # The disconnect makes the LLM ABORTED -> transient fallback (fallback provenance is attached).
    assert spec["provenance"].get("fallback") is not None


def test_compose_route_disconnect_does_not_record_lineage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cancelled compose (client disconnect) still delivers a fallback Spec, but records neither
    view.composed nor view.fallback — mirrors the TS host-rest observability test of the same intent."""

    async def _always_disconnected(_self: Request) -> bool:
        return True

    monkeypatch.setattr(Request, "is_disconnected", _always_disconnected)

    deps, lineage = _deps_with_recorder(tmp_path, _abort_respecting_llm())
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)

    res = client.post(f"{PREFIX}/compose", json={"intent": INTENT_BODY})
    assert res.status_code == 200
    spec = res.json()["spec"]
    assert spec["provenance"].get("fallback") is not None

    events = asyncio.run(lineage.list_events())
    assert events == []


def test_compose_stream_body_aclose_does_not_report_error(tmp_path: Path) -> None:
    """aclose() mid-stream does not call on_error (report_host_error) and raises no exception.

    Prevents a regression where except BaseException could report GeneratorExit as a spurious COMPOSE_FAILED.
    """
    errors: list[object] = []

    def on_error(info: object) -> None:
        errors.append(info)

    harness = build_harness(tmp_path, on_error=on_error)
    intent = finalize_intent(IntentInput(canonical="sales.summary", params={"fy": 2026}))

    async def run() -> None:
        gen = _compose_stream_body(
            harness.deps,
            intent,
            SessionContext(surface="web"),
            Principal(id="tester", roles=["user"]),
            request_id="req-aclose",
        )
        # Receive the first SSE chunk, then aclose (send GeneratorExit into the body).
        first = await gen.__anext__()
        assert first.startswith("event:")
        await gen.aclose()

    asyncio.run(run())
    assert errors == []


def _failing_cache_deps(tmp_path: Path, on_error: Any) -> KohakuHostDeps:
    """Harness whose storage.get_spec_cache always raises a raw (untyped) Error, combined with
    policy.cacheFailure="closed" so it rethrows unwrapped through prepare_compose (composer's own fail-open
    cache-lookup wrapper otherwise swallows a cache-backend failure as a miss) — a genuinely untyped "hard"
    compose_stream failure, unlike a semantic.resolve_query failure (which the composer wraps into a typed
    ComposeError before it ever reaches host_rest)."""
    harness = build_harness(tmp_path, on_error=on_error)
    harness.deps.compose = dataclasses.replace(harness.ctx, policy=ComposePolicy(cacheFailure="closed"))

    async def _boom(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("secret storage backend detail")

    harness.storage.get_spec_cache = _boom  # type: ignore[method-assign]
    return harness.deps


def test_compose_stream_body_skips_report_and_error_when_already_aborted(tmp_path: Path) -> None:
    """§4.5 R2: when abort is already fired (client disconnected) before the body's failure surfaces,
    _compose_stream_body must not call on_error nor yield an event: error (mirrors TS
    compose-stream-disconnect.test.ts)."""
    seen: list[HostErrorInfo] = []
    deps = _failing_cache_deps(tmp_path, lambda info: seen.append(info))
    intent = finalize_intent(IntentInput(canonical="sales.summary", params={"fy": 2026}))

    async def run() -> list[str]:
        controller = AbortController()
        controller.abort()  # the client is already gone before the body observes the failure
        chunks: list[str] = []
        async for chunk in _compose_stream_body(
            deps,
            intent,
            SessionContext(surface="web"),
            Principal(id="tester", roles=["user"]),
            request_id="req-abort",
            abort=controller.signal,
        ):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(run())
    assert not any("event: error" in c for c in chunks)
    assert seen == []


def test_compose_stream_body_control_reports_and_masks_when_not_aborted(tmp_path: Path) -> None:
    """Control: the identical failure without a disconnect still reports to on_error and masks the raw
    exception's message in the emitted event: error (§2 #8's SSE COMPOSE_FAILED gating)."""
    seen: list[HostErrorInfo] = []
    deps = _failing_cache_deps(tmp_path, lambda info: seen.append(info))
    intent = finalize_intent(IntentInput(canonical="sales.summary", params={"fy": 2026}))

    async def run() -> list[str]:
        chunks: list[str] = []
        async for chunk in _compose_stream_body(
            deps,
            intent,
            SessionContext(surface="web"),
            Principal(id="tester", roles=["user"]),
            request_id="req-normal",
        ):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(run())
    text = "".join(chunks)
    assert "event: error" in text
    assert "secret storage backend detail" not in text
    assert len(seen) == 1
    assert seen[0].endpoint == "compose/stream"
