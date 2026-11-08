"""Tests for kohaku.storage.redis.keys (port of packages/storage-redis/test/keys.test.ts), plus literal keys that
pin the layout shared byte-for-byte with the TS adapter -- the Docker-free half of the data-compatibility check."""

from __future__ import annotations

from kohaku.storage.redis import redis_keys, tenant_segment


class TestTenantSegment:
    def test_maps_a_missing_or_empty_tenant_to_the_neutral_marker(self) -> None:
        assert tenant_segment(None) == "%"
        assert tenant_segment("") == "%"

    def test_percent_encodes_a_tenant_so_colon_and_percent_cannot_collide_with_the_layout(
        self,
    ) -> None:
        assert tenant_segment("acme:eu") == "acme%3Aeu"
        assert tenant_segment("%") == "%25"

    def test_encodes_exactly_as_javascripts_encode_uri_component_does(self) -> None:
        # Pinned from `node -e 'console.log(encodeURIComponent("a/b c%ü!~*()\'"))'`: urllib's quote() would leave
        # "/" alone and escape "!*'()", and the key would silently differ from the one a TS host writes.
        assert tenant_segment("a/b c%ü!~*()'") == "a%2Fb%20c%25%C3%BC!~*()'"


class TestRedisKeys:
    keys = redis_keys()

    def test_uses_the_default_prefix(self) -> None:
        assert self.keys.spec("k1") == "kohaku:spec:k1"
        assert self.keys.lineage.events == "kohaku:lineage:events"
        assert self.keys.lineage.seq == "kohaku:lineage:seq"
        assert self.keys.lineage.by_seq == "kohaku:lineage:by-seq"
        assert (
            self.keys.lineage.index("type", "view.composed")
            == "kohaku:lineage:idx:type:view.composed"
        )

    def test_keys_promotion_and_fixation_by_tenant_and_id_with_neutral_and_per_tenant_indexes(
        self,
    ) -> None:
        assert self.keys.promotion("acme", "a1") == "kohaku:acme:promotion:a1"
        assert self.keys.promotion(None, "a1") == "kohaku:%:promotion:a1"
        assert self.keys.promotion_index("acme") == "kohaku:acme:promotion:index"
        assert self.keys.promotion_index(None) == "kohaku:promotion:index"
        assert self.keys.promotion_seq == "kohaku:promotion:seq"
        assert self.keys.fixation("acme", "sha256:ab") == "kohaku:acme:fixation:sha256:ab"
        assert self.keys.fixation_index(None) == "kohaku:fixation:index"
        assert self.keys.fixation_seq == "kohaku:fixation:seq"

    def test_honours_a_custom_prefix(self) -> None:
        assert redis_keys("app1").spec("k") == "app1:spec:k"

    def test_keys_a_capability_revocation_record_by_jti(self) -> None:
        assert self.keys.revoked("jti-1") == "kohaku:revoked:jti-1"
        assert redis_keys("app1").revoked("jti-1") == "app1:revoked:jti-1"

    def test_treats_an_empty_string_tenant_exactly_like_an_omitted_one_everywhere(self) -> None:
        assert self.keys.promotion("", "a1") == self.keys.promotion(None, "a1")
        assert self.keys.promotion_index("") == self.keys.promotion_index(None)
        assert self.keys.fixation("", "sha256:ab") == self.keys.fixation(None, "sha256:ab")
        assert self.keys.fixation_index("") == self.keys.fixation_index(None)
