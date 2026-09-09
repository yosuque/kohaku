"""Deterministic normalization and hashing of an already-structured Intent (port of packages/spec-core/src/intent.ts).

Distinct from the natural-language → Intent conversion (SemanticPort.normalize); this only guarantees that
"Intents with the same meaning produce the same byte sequence".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .canonical_json import canonical_stringify, normalize_json_value, sha256_hex
from .models import Intent


@dataclass(frozen=True)
class IntentInput:
    """Intent before the hash is filled in (the return value of SemanticPort.normalize)."""

    canonical: str
    params: dict[str, Any]


def normalize_intent(intent: IntentInput) -> IntentInput:
    """Deterministic normalization that deep-sorts params keys and removes UNDEFINED."""
    normalized = normalize_json_value(intent.params)
    assert isinstance(normalized, dict)
    return IntentInput(canonical=intent.canonical, params=normalized)


def _hash_normalized(normalized: IntentInput) -> str:
    """Compute the hash string from an already-normalized Intent (no re-normalization)."""
    hex_digest = sha256_hex(
        canonical_stringify({"canonical": normalized.canonical, "params": normalized.params})
    )
    return f"sha256:{hex_digest}"


def compute_intent_hash(intent: IntentInput) -> str:
    return _hash_normalized(normalize_intent(intent))


def finalize_intent(intent: IntentInput | Intent) -> Intent:
    """Return a normalized, hash-filled CanonicalIntent (normalization runs exactly once).

    When `intent` is already an `Intent` (a CanonicalIntent — a caller re-finalizing an already-finalized
    Intent unchanged), the hash computation is skipped and the value is returned as-is: its params are
    already canonical-order-normalized from the call that produced it, so recomputing sha256 over the
    identical bytes would be pure waste. The exported signature widens to accept either type but keeps
    returning `Intent`, so existing callers passing a plain `IntentInput` are unaffected.
    """
    if isinstance(intent, Intent):
        return intent
    normalized = normalize_intent(intent)
    return Intent(
        canonical=normalized.canonical,
        params=normalized.params,
        hash=_hash_normalized(normalized),
    )
