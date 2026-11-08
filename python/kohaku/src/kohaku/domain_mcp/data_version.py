"""A time-bucket `dataVersion` for an upstream with no version of its own (port of data-version.ts)."""

from __future__ import annotations

import math
import time
from collections.abc import Callable

# Default width of a data-version bucket, in seconds.
DEFAULT_BUCKET_SECONDS = 300


def mcp_data_version(
    *, bucket_seconds: int = DEFAULT_BUCKET_SECONDS, now: Callable[[], float] | None = None
) -> Callable[[], str]:
    """A `dataVersion` source: a string that changes every `bucket_seconds`, `mcp:<floor(now / bucket)>`.

    Every Spec composed inside one bucket carries the same version, and the data resolved for it is stamped
    with the same one, so the renderer's stale-version check stays quiet inside a bucket. `now` returns epoch
    **seconds** (default `time.time`); the TS counterpart takes epoch milliseconds, as `Date.now` does.
    """
    if (
        isinstance(bucket_seconds, bool)
        or not isinstance(bucket_seconds, int)
        or bucket_seconds <= 0
    ):
        raise ValueError(
            f"mcp_data_version: bucket_seconds must be a positive integer, got {bucket_seconds}"
        )
    clock = now if now is not None else time.time
    return lambda: f"mcp:{math.floor(clock() / bucket_seconds)}"
