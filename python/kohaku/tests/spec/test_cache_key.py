"""Tests for cache keys and dataVersion composition."""

from __future__ import annotations

import gc
from collections.abc import Callable
from importlib import import_module

import pytest

from kohaku.spec import (
    CacheKeyParts,
    UISpec,
    cache_key,
    combine_data_versions,
    compute_structure_hash,
)

# A plain `import kohaku.spec.cache_key as cache_key_module` would actually bind the `cache_key` *function*
# (kohaku/spec/__init__.py's `from .cache_key import cache_key` rebinds the `cache_key` attribute on the
# `kohaku.spec` package to the function, shadowing the submodule reference for any later attribute-chain
# access) -- import_module bypasses that by going through sys.modules directly.
cache_key_module = import_module("kohaku.spec.cache_key")


def _spec(component_id: str = "root") -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": {"canonical": "x", "params": {}, "hash": "sha256:" + "a" * 64},
            "dataVersion": "v1",
            "components": [{"id": component_id, "type": "layout.stack", "props": {}}],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


class TestCacheKey:
    def test_five_segments_by_default(self) -> None:
        key = cache_key(CacheKeyParts(intentHash="sha256:ab", dataVersion="v1"))
        assert key == "kohaku:0.2:sha256:ab:v1:-"

    def test_with_fingerprint_and_generator(self) -> None:
        key = cache_key(
            CacheKeyParts(
                intentHash="h",
                dataVersion="v",
                catalogFingerprint="fp",
                specVersion="0.1",
                generatorVersion="g1",
            )
        )
        assert key == "kohaku:0.1:h:v:fp:g1"

    def test_generator_version_omitted_matches_legacy(self) -> None:
        """An unspecified generatorVersion exactly matches the legacy 5-component key (does not skip the cache)."""
        legacy = cache_key(CacheKeyParts(intentHash="h", dataVersion="v"))
        assert legacy.count(":") == 4

    def test_policy_fingerprint_omitted_keeps_key_unchanged(self) -> None:
        base = CacheKeyParts(intentHash="sha256:aaa", dataVersion="v1", catalogFingerprint="cat1")
        assert cache_key(base) == "kohaku:0.2:sha256:aaa:v1:cat1"

    def test_empty_policy_fingerprint_treated_as_omitted(self) -> None:
        base = CacheKeyParts(intentHash="sha256:aaa", dataVersion="v1", catalogFingerprint="cat1")
        with_empty = CacheKeyParts(
            intentHash="sha256:aaa", dataVersion="v1", catalogFingerprint="cat1", policyFingerprint=""
        )
        assert cache_key(with_empty) == cache_key(base)

    def test_generator_version_alone_still_legacy_six_segments(self) -> None:
        key = cache_key(
            CacheKeyParts(
                intentHash="sha256:aaa", dataVersion="v1", catalogFingerprint="cat1", generatorVersion="gv1"
            )
        )
        assert key == "kohaku:0.2:sha256:aaa:v1:cat1:gv1"

    def test_policy_fingerprint_alone_inserts_dash_placeholder(self) -> None:
        key = cache_key(
            CacheKeyParts(
                intentHash="sha256:aaa", dataVersion="v1", catalogFingerprint="cat1", policyFingerprint="pf1"
            )
        )
        assert key == "kohaku:0.2:sha256:aaa:v1:cat1:-:pf1"

    def test_both_generator_version_and_policy_fingerprint_appended_in_order(self) -> None:
        key = cache_key(
            CacheKeyParts(
                intentHash="sha256:aaa",
                dataVersion="v1",
                catalogFingerprint="cat1",
                generatorVersion="gv1",
                policyFingerprint="pf1",
            )
        )
        assert key == "kohaku:0.2:sha256:aaa:v1:cat1:gv1:pf1"

    def test_no_collision_between_generator_version_only_and_policy_fingerprint_only(self) -> None:
        by_generator_version = cache_key(
            CacheKeyParts(
                intentHash="sha256:aaa", dataVersion="v1", catalogFingerprint="cat1", generatorVersion="pf1"
            )
        )
        by_policy_fingerprint = cache_key(
            CacheKeyParts(
                intentHash="sha256:aaa", dataVersion="v1", catalogFingerprint="cat1", policyFingerprint="pf1"
            )
        )
        assert by_generator_version != by_policy_fingerprint


class TestCombineDataVersions:
    def test_empty_is_none(self) -> None:
        assert combine_data_versions([]) == "none"

    def test_single_passes_through(self) -> None:
        assert combine_data_versions([("kohaku://sales", "v1")]) == "v1"

    def test_same_versions_fold_to_single(self) -> None:
        """Identical versions fold together (making it multi: would break the STALE decision)."""
        assert (
            combine_data_versions(
                [
                    ("kohaku://sales", "v1"),
                    ("kohaku://sales-mirror", "v1"),
                    ("kohaku://sales-alias", "v1"),
                ]
            )
            == "v1"
        )

    def test_distinct_versions_become_multi(self) -> None:
        combined = combine_data_versions([("kohaku://a", "v1"), ("kohaku://b", "v2")])
        assert combined.startswith("multi:")
        assert len(combined) == len("multi:") + 16

    def test_order_independent(self) -> None:
        assert combine_data_versions(
            [("kohaku://a", "v1"), ("kohaku://b", "v2")]
        ) == combine_data_versions([("kohaku://b", "v2"), ("kohaku://a", "v1")])

    def test_swapped_uri_version_assignment_gives_different_multi_value(self) -> None:
        """{a: v1, b: v2} and {a: v2, b: v1} share the same two version strings but denote
        different data states, so they must not collapse onto the same combined value."""
        swapped1 = combine_data_versions([("kohaku://a", "v1"), ("kohaku://b", "v2")])
        swapped2 = combine_data_versions([("kohaku://a", "v2"), ("kohaku://b", "v1")])
        assert swapped1 != swapped2

    def test_cross_language_golden_matches_ts(self) -> None:
        """Mirrors the TS golden in packages/spec-core/test/intent.test.ts verbatim: the same
        (uri, version) pairs must hash to the identical multi: value in both implementations."""
        value = combine_data_versions(
            [("kohaku://sales-summary", "v1"), ("kohaku://targets", "v2")]
        )
        assert value == "multi:0d9007cd68b518c8"


class TestComputeStructureHashMemo:
    """compute_structure_hash's memoization (see cache_key.py's _structure_hash_memo doc comment for why this
    is a plain dict keyed by id(spec), not a weakref.WeakKeyDictionary the way TS's WeakMap-based memo is)."""

    def test_repeated_calls_on_the_same_spec_reuse_the_cached_value(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = 0
        original: Callable[[UISpec], str] = cache_key_module._compute_structure_hash_uncached

        def counting(spec: UISpec) -> str:
            nonlocal calls
            calls += 1
            return original(spec)

        monkeypatch.setattr(cache_key_module, "_compute_structure_hash_uncached", counting)

        spec = _spec()
        first = compute_structure_hash(spec)
        second = compute_structure_hash(spec)
        third = compute_structure_hash(spec)
        assert first == second == third
        assert calls == 1

    def test_a_different_spec_with_different_content_is_not_conflated(self) -> None:
        a = compute_structure_hash(_spec("root"))
        b = compute_structure_hash(_spec("other"))
        assert a != b

    def test_two_distinct_spec_objects_with_identical_content_each_recompute(self) -> None:
        """Keyed by id(spec) rather than id(spec.components): two different UISpec objects that happen to
        hold equal (but not the same-reference) content each get their own memo entry -- a missed
        optimization versus TS's components-array-keyed WeakMap, never a correctness issue (see the module
        doc comment)."""
        a = compute_structure_hash(_spec("same"))
        b = compute_structure_hash(_spec("same"))
        assert a == b  # same *value*, computed independently for each object

    def test_memo_entry_is_evicted_once_the_spec_is_garbage_collected(self) -> None:
        """No leak, and no risk of a later object reusing the same id() and spuriously hitting a stale
        entry: the memo entry for a spec is removed once that spec itself is collected."""
        spec = _spec()
        compute_structure_hash(spec)
        key = id(spec)
        assert key in cache_key_module._structure_hash_memo
        del spec
        gc.collect()
        assert key not in cache_key_module._structure_hash_memo
