"""Port of packages/lineage/src/revision.ts: the per-write revision token shared by the fixation service
(FixationRecord.revision) and the promotion candidate store (PromotionState.revision) -- the tokens a
StoragePort that declares supports_compare_and_set compares on a conditional write."""

from __future__ import annotations

import random
import time

_BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def _to_base36(n: int) -> str:
    """Mirrors JS's `Number.prototype.toString(36)` for a non-negative integer (used only by
    generate_revision; no need to handle negative numbers)."""
    if n == 0:
        return "0"
    digits: list[str] = []
    while n > 0:
        n, rem = divmod(n, 36)
        digits.append(_BASE36_ALPHABET[rem])
    return "".join(reversed(digits))


def generate_revision() -> str:
    """Generates a coarse ulid-like, per-write revision token: a base36 ms timestamp plus a random suffix.
    Not the full `ulid` scheme (no cross-service sortability guarantee is needed here) -- only
    "distinguishable from the previous write even inside the same millisecond" matters, which a timestamp
    such as fixatedAt (an ms-precision ISO string) cannot provide (an unfixate -> fixate pair landing in the
    same ms would otherwise share a TOCTOU guard token with the fixation it replaced)."""
    return f"{_to_base36(int(time.time() * 1000))}-{_to_base36(random.getrandbits(40))}"
