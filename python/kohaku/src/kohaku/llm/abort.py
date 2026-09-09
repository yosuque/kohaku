"""Abort signal (a minimal implementation of the Web's AbortController / AbortSignal).

The TS version uses the global `AbortSignal` (`AbortSignal.timeout` / `AbortSignal.any`).
Since the Python standard library has no equivalent, only the surface that `retry.py`
and the adapters need is ported here:

- `aborted` / `reason` (the aborted flag and the reason)
- `throw_if_aborted()` (raise if already aborted)
- `timeout(ms)` (abort after the given milliseconds; used as the provider stall limit)
- `any(signals)` (composition of multiple signals; used to merge caller abort + timeout)
- `default_sleep(ms, signal)` (a signal-respecting wait; rejects with the reason on abort)

This is kept independent of `asyncio` cancellation (`CancelledError`) so that `retry.py`'s
decision (whether an error originates from `AbortError`) stays deterministic.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable


class AbortError(Exception):
    """An abort caused by caller cancellation or a timeout. Retry propagates it immediately without retrying."""


class TimeoutAbortError(AbortError):
    """An abort caused by exceeding the timeout (equivalent to TS's TimeoutError). Classified as ABORTED."""


def _noop() -> None:
    return None


class AbortSignal:
    """A minimal signal holding the aborted flag, its reason, and listeners."""

    def __init__(self) -> None:
        self._aborted = False
        self._reason: BaseException | None = None
        self._listeners: list[Callable[[], None]] = []
        self._timer: asyncio.TimerHandle | None = None

    @property
    def aborted(self) -> bool:
        return self._aborted

    @property
    def reason(self) -> BaseException | None:
        return self._reason

    def throw_if_aborted(self) -> None:
        if self._aborted:
            raise self._reason if self._reason is not None else AbortError("aborted")

    def add_listener(self, callback: Callable[[], None]) -> Callable[[], None]:
        """Register a listener called once on abort and return an unsubscribe function. If already aborted at registration, run it immediately."""
        if self._aborted:
            callback()
            return _noop
        self._listeners.append(callback)

        def _remove() -> None:
            try:
                self._listeners.remove(callback)
            except ValueError:
                pass

        return _remove

    def _fire(self, reason: BaseException) -> None:
        if self._aborted:
            return
        self._aborted = True
        self._reason = reason
        listeners = list(self._listeners)
        self._listeners.clear()
        for callback in listeners:
            callback()

    def cancel_timer(self) -> None:
        """Cancel the timer armed by `timeout` (call on operation completion to prevent a delayed firing)."""
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    @staticmethod
    def timeout(ms: float) -> AbortSignal:
        """A signal that aborts after the given milliseconds. Requires a running event loop (use in async context)."""
        signal = AbortSignal()
        loop = asyncio.get_running_loop()
        signal._timer = loop.call_later(
            ms / 1000.0, lambda: signal._fire(TimeoutAbortError("timed out"))
        )
        return signal

    @staticmethod
    def any(signals: Iterable[AbortSignal]) -> AbortSignal:
        """A composed signal that aborts when any of the given signals aborts."""
        merged = AbortSignal()

        def _forward(source: AbortSignal) -> Callable[[], None]:
            def _callback() -> None:
                reason = source.reason if source.reason is not None else AbortError("aborted")
                merged._fire(reason)

            return _callback

        for source in signals:
            if source.aborted:
                reason = source.reason if source.reason is not None else AbortError("aborted")
                merged._fire(reason)
                return merged
            source.add_listener(_forward(source))
        return merged


class AbortController:
    """The sender-side handle that holds `signal` and aborts it via `abort()`."""

    def __init__(self) -> None:
        self.signal = AbortSignal()

    def abort(self, reason: BaseException | None = None) -> None:
        self.signal._fire(reason if reason is not None else AbortError("aborted"))


async def default_sleep(ms: float, signal: AbortSignal) -> None:
    """A signal-respecting wait. Raises with the reason on abort."""
    if signal.aborted:
        raise signal.reason if signal.reason is not None else AbortError("aborted")
    if ms <= 0:
        return
    loop = asyncio.get_running_loop()
    future: asyncio.Future[None] = loop.create_future()

    def _on_abort() -> None:
        if not future.done():
            future.set_exception(
                signal.reason if signal.reason is not None else AbortError("aborted")
            )

    unsubscribe = signal.add_listener(_on_abort)
    timer = loop.call_later(ms / 1000.0, lambda: None if future.done() else future.set_result(None))
    try:
        await future
    finally:
        timer.cancel()
        unsubscribe()
