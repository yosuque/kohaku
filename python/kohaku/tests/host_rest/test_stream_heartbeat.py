"""SSE keepalive heartbeat (_with_heartbeat) overlay test (SRE-1).

Checks that _with_heartbeat, which realizes the setInterval equivalent of the TS reference (the
heartbeat inside `deliverComposedStream` in packages/host-rest/src/routes/compose.ts) with asyncio,
inserts `: keepalive` into silent intervals while preserving the body events. The interval is injected
via an argument for fast verification (the default SSE_HEARTBEAT_INTERVAL_S=15s is not used).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

from kohaku.host_rest._fastapi_routes import _with_heartbeat


async def _slow_body() -> AsyncIterator[str]:
    """A body that creates a silent interval before each event (leaves room for keepalive to be inserted)."""
    await asyncio.sleep(0.08)
    yield "event: spec\ndata: {}\n\n"
    await asyncio.sleep(0.08)
    yield "event: done\ndata: {}\n\n"


def test_keepalive_interleaved_and_body_preserved() -> None:
    async def run() -> list[str]:
        # Take the interval sufficiently shorter than the body's silence so keepalive is inserted even with scheduler jitter.
        return [chunk async for chunk in _with_heartbeat(_slow_body(), 0.01)]

    out = asyncio.run(run())
    # A keepalive comment line is overlaid onto the body's silent intervals.
    assert ": keepalive\n\n" in out
    # The body events are preserved in order and content, and keepalive is only comment lines (leading ":").
    body = [c for c in out if not c.startswith(":")]
    assert body == ["event: spec\ndata: {}\n\n", "event: done\ndata: {}\n\n"]
    # The last is the body's done (keepalive stops at the generation-completion sentinel).
    assert out[-1] == "event: done\ndata: {}\n\n"


def test_no_keepalive_when_body_never_idles() -> None:
    async def _fast_body() -> AsyncIterator[str]:
        yield "event: done\ndata: {}\n\n"

    async def run() -> list[str]:
        # With a sufficiently large interval, keepalive never occurs.
        return [chunk async for chunk in _with_heartbeat(_fast_body(), 100.0)]

    assert asyncio.run(run()) == ["event: done\ndata: {}\n\n"]


def test_body_exception_propagates_after_terminating() -> None:
    async def _boom_body() -> AsyncIterator[str]:
        yield "event: spec\ndata: {}\n\n"
        raise RuntimeError("body failure")

    async def run() -> list[str]:
        return [chunk async for chunk in _with_heartbeat(_boom_body(), 100.0)]

    # Not swallowed by keepalive; the body's exception is re-raised after terminating.
    with pytest.raises(RuntimeError, match="body failure"):
        asyncio.run(run())
