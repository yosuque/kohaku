"""Time helpers shared by the HMAC ports and the in-memory stores (port of packages/authz-hmac/src/time.ts).

The single source of "now" for expiry checks, so `verify` / `revoke_capability` and the memory revocation store's
sweep all treat "expired" as the same boundary: a token is expired exactly at its `exp` instant (`exp <= now`),
not only strictly after it.
"""

from __future__ import annotations

import time as _time


def now_seconds() -> int:
    """Current time in epoch seconds (floor)."""
    return int(_time.time())


def is_expired(exp: float, now: float) -> bool:
    """Whether a token's `exp` claim (epoch seconds) has passed at `now`. `now` is floored first, so a clock
    that reports fractional seconds (a test double, `time.time`) agrees with TS's `Math.floor(Date.now() / 1000)`."""
    return exp <= int(now)
