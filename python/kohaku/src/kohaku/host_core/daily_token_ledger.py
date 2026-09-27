"""A UTC-day-scoped daily token ledger (port of packages/host-core/src/daily-token-ledger.ts)."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime


@dataclass
class _LedgerEntry:
    """One key's ledger entry: the UTC day (`YYYY-MM-DD`) the running total was last recorded against."""

    day: str
    spent_tokens: int


def _utc_day(now_ms: float) -> str:
    """`YYYY-MM-DD` in UTC."""
    return datetime.fromtimestamp(now_ms / 1000, tz=UTC).date().isoformat()


def _default_now_ms() -> float:
    """Epoch milliseconds (matches host_core.rate_limit's own default -- a ledger reset by UTC calendar
    date needs a wall-clock epoch, not time.monotonic()'s arbitrary reference point)."""
    return time.time() * 1000


class DailyTokenLedger:
    """An in-process, per-key cumulative token ledger scoped to the current UTC calendar day. Backs a
    ComposeBudget.check_with_context/on_usage pair for a daily token budget (the Policy file's
    compose.budget.dailyTokens, kohaku.spec.policy) -- create_policy_runtime (a later commit on this
    branch) is the intended caller: check_with_context reads spent(tenant) and denies once it reaches
    dailyTokens, on_usage calls record(tenant, usage.inputTokens + usage.outputTokens) after a compose
    that actually generated.

    State lives only in this process and is lost on restart (the Zero-Port default, like
    MemoryRateLimitStore) -- a product running several host instances, or that needs the ledger to
    survive a restart, needs a shared backing store instead.
    """

    def __init__(self, now: Callable[[], float] = _default_now_ms) -> None:
        self._now = now
        self._entries: dict[str, _LedgerEntry] = {}

    def spent(self, key: str) -> int:
        """The current UTC day's cumulative tokens recorded for `key` (0 if the day has rolled over
        since the last `record`, or `key` is new)."""
        entry = self._entries.get(key)
        if entry is None or entry.day != _utc_day(self._now()):
            return 0
        return entry.spent_tokens

    def record(self, key: str, tokens: int) -> None:
        """Adds `tokens` to `key`'s running total for the UTC day containing the ledger's current time.
        Rolls over automatically: if the stored day for `key` differs from today's (UTC), the total
        resets to `tokens` rather than accumulating onto yesterday's figure."""
        day = _utc_day(self._now())
        entry = self._entries.get(key)
        if entry is None or entry.day != day:
            self._entries[key] = _LedgerEntry(day=day, spent_tokens=tokens)
        else:
            entry.spent_tokens += tokens


def create_daily_token_ledger(now: Callable[[], float] = _default_now_ms) -> DailyTokenLedger:
    """Factory matching TS's createDailyTokenLedger naming (kohaku's other create_* host-core factories)."""
    return DailyTokenLedger(now)
