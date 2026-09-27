"""A UTC-day-scoped daily token ledger (port of packages/host-core/src/daily-token-ledger.ts)."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from .rate_limit import DEFAULT_MAX_MEMORY_ENTRIES


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

    Bounded memory (max_entries, default DEFAULT_MAX_MEMORY_ENTRIES): without a cap, a key that stops
    being used would keep its entry forever, so the dict would grow with the number of distinct keys ever
    seen (unbounded for a product with unboundedly many tenants/keys). Eviction is LRU, the same scheme
    MemoryRateLimitStore uses (a dict iterates in insertion order, and every touch deletes then
    re-inserts the key, so the first key in iteration order is always the least-recently-touched one).
    Separately, entries for a UTC day that has already ended are dead weight regardless of max_entries --
    on the first call after the day rolls over, every entry whose stored day differs from the new day is
    swept out in one pass (not checked per call), rather than waiting for LRU pressure to evict them.
    """

    def __init__(
        self,
        now: Callable[[], float] = _default_now_ms,
        max_entries: int = DEFAULT_MAX_MEMORY_ENTRIES,
    ) -> None:
        self._now = now
        self._max_entries = max_entries
        self._entries: dict[str, _LedgerEntry] = {}
        self._last_known_day: str | None = None

    def _prune_on_rollover(self, day: str) -> None:
        """Sweeps out every entry from a UTC day other than `day`, once per day (a no-op after the first
        call of a given day)."""
        if self._last_known_day == day:
            return
        self._last_known_day = day
        for key in [k for k, entry in self._entries.items() if entry.day != day]:
            del self._entries[key]

    def spent(self, key: str) -> int:
        """The current UTC day's cumulative tokens recorded for `key` (0 if the day has rolled over
        since the last `record`, or `key` is new)."""
        day = _utc_day(self._now())
        self._prune_on_rollover(day)
        entry = self._entries.get(key)
        if entry is None or entry.day != day:
            return 0
        return entry.spent_tokens

    def record(self, key: str, tokens: int) -> None:
        """Adds `tokens` to `key`'s running total for the UTC day containing the ledger's current time.
        Rolls over automatically: if the stored day for `key` differs from today's (UTC), the total
        resets to `tokens` rather than accumulating onto yesterday's figure."""
        day = _utc_day(self._now())
        self._prune_on_rollover(day)
        existing = self._entries.get(key)
        if existing is not None and existing.day == day:
            del self._entries[key]  # reinsert below to mark as most-recently-used
            existing.spent_tokens += tokens
            self._entries[key] = existing
            return
        # A brand-new key, or an existing key whose entry is from a previous day (reset, not
        # accumulated) -- either way this is a fresh entry for today. A genuinely new key may need to
        # evict something to make room; an existing (stale) key is deleted first so re-inserting it
        # below also moves it to the most-recently-used position, instead of leaving it at whatever
        # position its now-overwritten previous-day entry happened to occupy.
        if existing is None:
            if len(self._entries) >= self._max_entries:
                oldest_key = next(iter(self._entries), None)
                if oldest_key is not None:
                    del self._entries[oldest_key]
        else:
            del self._entries[key]
        self._entries[key] = _LedgerEntry(day=day, spent_tokens=tokens)


def create_daily_token_ledger(
    now: Callable[[], float] = _default_now_ms,
    max_entries: int = DEFAULT_MAX_MEMORY_ENTRIES,
) -> DailyTokenLedger:
    """Factory matching TS's createDailyTokenLedger naming (kohaku's other create_* host-core factories)."""
    return DailyTokenLedger(now, max_entries)
