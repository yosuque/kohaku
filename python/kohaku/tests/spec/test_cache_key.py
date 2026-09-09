"""Tests for cache keys and dataVersion composition."""

from __future__ import annotations

from kohaku.spec import CacheKeyParts, cache_key, combine_data_versions


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
