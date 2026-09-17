"""Cache key and Spec hash (port of TS cache-key.ts).

The TS implementation is async due to WebCrypto, but Python's hashlib is synchronous, so these are
synchronous functions.
"""

from __future__ import annotations

import weakref
from dataclasses import dataclass

from .canonical_json import _utf16_key, canonical_stringify, sha256_hex
from .models import SPEC_VERSION, UISpec


@dataclass(frozen=True)
class CacheKeyParts:
    intentHash: str
    dataVersion: str
    catalogFingerprint: str | None = None
    """Component that prevents mixing up an old Spec when a component is revised."""
    specVersion: str | None = None
    generatorVersion: str | None = None
    """Generator version. An optional component that separates the cache on prompt revisions / model changes.

    If unspecified, matches the previous 5-component key exactly (prevents the cache from being invalidated on introduction).
    """
    policyFingerprint: str | None = None
    """A fingerprint of the ComposePolicy fields that affect prompt content but were not otherwise
    reflected in the cache key (outputLanguage / designSystem / fewShot.id / selectComponents.id — see
    composer.context.policy_fingerprint). Appended as the 7th component, after generatorVersion. If
    omitted (or the empty string), the key is completely unchanged from before this field existed. Because
    this component sits after generatorVersion positionally, a "-" placeholder is inserted in the
    generatorVersion slot when this is given but generatorVersion is not, so the two never collide on the
    same string for different inputs (mirrors TS spec-core's cacheKey exactly).
    """


def cache_key(parts: CacheKeyParts) -> str:
    """Spec cache key (Intent + data version, + catalog fingerprint)."""
    segments = [
        "kohaku",
        parts.specVersion if parts.specVersion is not None else SPEC_VERSION,
        parts.intentHash,
        parts.dataVersion,
        parts.catalogFingerprint if parts.catalogFingerprint is not None else "-",
    ]
    policy_fingerprint = parts.policyFingerprint
    has_policy_fingerprint = policy_fingerprint is not None and policy_fingerprint != ""
    # generatorVersion is appended as a 6th component when specified, or as a "-" placeholder when
    # policyFingerprint (the 7th component) is given without it — keeping the two positionally distinct so
    # a generatorVersion-only key can never collide with a policyFingerprint-only key. If neither is given,
    # the string matches the legacy 5-component key exactly.
    if parts.generatorVersion is not None or has_policy_fingerprint:
        segments.append(parts.generatorVersion if parts.generatorVersion is not None else "-")
    if has_policy_fingerprint and policy_fingerprint is not None:
        segments.append(policy_fingerprint)
    return ":".join(segments)


def combine_data_versions(entries: list[tuple[str, str]]) -> str:
    """Deterministically combine the dataVersions of multiple QueryHandles.

    entries are (uri, version) pairs. Fold identical versions: when multiple $refs point at the same
    data source, they normalize to a single version and can be reconciled directly against each $ref's
    response dataVersion. Without dedup, even identical versions would become `multi:`, and the
    renderer's dataVersion reconciliation would always judge STALE. This single-version shortcut is why
    the bare version string (never a `multi:` wrapper) is still returned whenever there is only one
    distinct version, even though the input is now uri-aware.

    The combined hash is uri-aware (`uri=version` pairs, sorted, then hashed) rather than a hash of the
    version values alone, so that {a: v1, b: v2} and {a: v2, b: v1} never collapse onto the same cache
    key merely because the same two version strings happen to appear.
    """
    unique = list(dict.fromkeys(version for _uri, version in entries))
    if len(unique) == 0:
        return "none"
    if len(unique) == 1:
        return unique[0]
    pairs = [f"{uri}={version}" for uri, version in entries]
    sorted_pairs = sorted(pairs, key=_utf16_key)
    hex_digest = sha256_hex("|".join(sorted_pairs))
    # 64 bits (16 hex) is enough: a multi: value never matches a single dataVersion in STALE judgment, so
    # collisions are harmless. Its birthday-collision room as a cache-key component has negligible impact.
    return f"multi:{hex_digest[:16]}"


def compute_spec_hash(spec: UISpec) -> str:
    """Deterministic hash of the whole Spec (used for View Lineage and the specHash reference in /events)."""
    return f"sha256:{sha256_hex(canonical_stringify(spec.to_wire()))}"


@dataclass
class _StructureHashMemoEntry:
    """One compute_structure_hash memo entry: the identity of the components/events/state it was computed
    against (a cheap staleness check on hit) plus the resulting hash."""

    components_id: int
    events_id: int
    state_id: int
    value: str


# Memoizes compute_structure_hash. A cache hit that returns the same in-memory UISpec object on repeated
# lookups (a common StoragePort.get_spec_cache shape) means re-hashing it on every single call (once per
# view.composed recording) is pure waste; this lets such repeats reuse the first computation.
#
# TS's structureHashMemo (cache-key.ts) is a `WeakMap<ComponentNode[], ...>` keyed on the Spec's `components`
# array reference. That exact shape does not carry over to Python: a plain `list` cannot be weakly referenced
# here (`weakref.ref([])` raises TypeError), and UISpec itself -- the only object in this pipeline pydantic
# actually allows a weak reference to -- has no `__hash__` (pydantic v2's BaseModel defines value-based
# `__eq__` without `__hash__`, so plain instances are unhashable and cannot be used as a
# `weakref.WeakKeyDictionary` key). Making UISpec hashable (`model_config = ConfigDict(frozen=True)`) was
# rejected as a fix: pydantic's frozen hash is computed from field *values*, which would force hashing the
# whole Spec structure on every lookup -- defeating the O(1) identity-check this memo exists for.
#
# So this is a plain dict keyed by `id(spec)` (the UISpec object's own identity) instead of a
# WeakKeyDictionary, with cleanup done manually via `weakref.finalize(spec, ...)` when the memo is written
# (UISpec itself IS weakly-referenceable, confirmed above) -- the same "no leak, no stale hit from an id()
# address reused by an unrelated later object" guarantee a WeakKeyDictionary would give, without requiring
# UISpec to become hashable. `components_id` / `events_id` / `state_id` are the secondary identity check on
# hit (mirroring TS's `cached.events === spec.events && cached.state === spec.state`): keying primarily on
# `id(spec)` rather than `id(spec.components)` narrows the hit rate slightly versus TS (two distinct UISpec
# wrapper objects sharing the same underlying components/events/state -- e.g. from `dataclasses.replace`-style
# rewrapping -- will not share a cache entry here), but that is a missed optimization, never a correctness
# risk: any actual reference reuse across genuinely different content is still caught by the identity check.
_structure_hash_memo: dict[int, _StructureHashMemoEntry] = {}


def compute_structure_hash(spec: UISpec) -> str:
    """Structure-only hash (components + events; provenance / dataVersion excluded).

    Used for the "structural stability" judgment of L1→L0 fixation. state is included in the input only when
    present (the hash of a Spec that does not use state stays completely unchanged from the previous value,
    protecting the fixation stability tally).

    Memoized by `spec`'s own identity (see `_structure_hash_memo`'s doc comment above for why this differs
    in shape, though not in intent, from TS's WeakMap-based memo).
    """
    key = id(spec)
    components_id, events_id, state_id = id(spec.components), id(spec.events), id(spec.state)
    cached = _structure_hash_memo.get(key)
    if (
        cached is not None
        and cached.components_id == components_id
        and cached.events_id == events_id
        and cached.state_id == state_id
    ):
        return cached.value
    value = _compute_structure_hash_uncached(spec)
    _structure_hash_memo[key] = _StructureHashMemoEntry(
        components_id=components_id, events_id=events_id, state_id=state_id, value=value
    )
    # Evict this entry once `spec` itself is garbage-collected, so the memo neither grows unboundedly nor
    # risks a later unrelated object reusing this exact `id()` and spuriously hitting a stale entry.
    weakref.finalize(spec, _structure_hash_memo.pop, key, None)
    return value


def _compute_structure_hash_uncached(spec: UISpec) -> str:
    structure: dict[str, object] = {
        "components": [c.to_wire() for c in spec.components],
        "events": [e.to_wire() for e in spec.events],
    }
    if spec.state is not None:
        structure["state"] = spec.state
    return f"sha256:{sha256_hex(canonical_stringify(structure))}"
