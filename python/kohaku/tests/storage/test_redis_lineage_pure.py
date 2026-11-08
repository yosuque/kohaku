"""Tests for the pure part of kohaku.storage.redis.lineage (port of packages/storage-redis/test/lineage-pure.test.ts):
which index entries an event contributes, and which index a filter reads from."""

from __future__ import annotations

from typing import Any

from kohaku.spec import LineageActor, LineageEventRecord, LineageFilter
from kohaku.storage.redis.lineage import (
    IndexValue,
    LineageIndexCandidate,
    choose_candidate_index,
    index_values,
    is_index_exhaustive,
)


def _ev(
    payload: dict[str, Any] | None = None, tenant: str | None = None, type_: str = "view.composed"
) -> LineageEventRecord:
    return LineageEventRecord(
        id="e1",
        ts="2026-01-01T00:00:00.000Z",
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload or {},
        tenant=tenant,
    )


class TestIndexValues:
    def test_emits_one_entry_per_present_index_field(self) -> None:
        assert index_values(
            _ev(
                {"intentHash": "sha256:a", "specHash": "sha256:s", "correlationId": "c1"},
                tenant="acme",
            )
        ) == [
            IndexValue("type", "view.composed"),
            IndexValue("tenant", "acme"),
            IndexValue("intentHash", "sha256:a"),
            IndexValue("specHash", "sha256:s"),
            IndexValue("correlationId", "c1"),
        ]
        assert index_values(_ev()) == [IndexValue("type", "view.composed")]

    def test_ignores_a_non_string_payload_hash(self) -> None:
        assert index_values(_ev({"artifactId": 42})) == [IndexValue("type", "view.composed")]

    def test_treats_an_empty_string_tenant_like_an_absent_one(self) -> None:
        assert index_values(_ev(tenant="")) == [IndexValue("type", "view.composed")]


class TestChooseCandidateIndex:
    def test_prefers_the_payload_hash_fields_over_type_and_tenant(self) -> None:
        assert choose_candidate_index(
            LineageFilter(type=["a"], tenant="t", intentHash="h")
        ) == LineageIndexCandidate("intentHash", ["h"])
        assert choose_candidate_index(
            LineageFilter(artifactId="a1", specHash="s1")
        ) == LineageIndexCandidate("artifactId", ["a1"])
        assert choose_candidate_index(
            LineageFilter(type=["a"], correlationId="c1")
        ) == LineageIndexCandidate("correlationId", ["c1"])

    def test_prefers_a_type_over_tenant(self) -> None:
        assert choose_candidate_index(
            LineageFilter(type=["a"], tenant="t")
        ) == LineageIndexCandidate("type", ["a"])
        assert choose_candidate_index(
            LineageFilter(type=["a", "b"], tenant="t")
        ) == LineageIndexCandidate("type", ["a", "b"])

    def test_falls_back_to_tenant_when_there_is_no_type_filter(self) -> None:
        assert choose_candidate_index(LineageFilter(tenant="t")) == LineageIndexCandidate(
            "tenant", ["t"]
        )

    def test_treats_an_empty_string_tenant_filter_as_unspecified(self) -> None:
        assert choose_candidate_index(LineageFilter(tenant="")) is None

    def test_returns_none_when_only_since_until_limit_are_given_or_type_is_an_empty_list(
        self,
    ) -> None:
        assert choose_candidate_index(LineageFilter(since="2026", limit=5)) is None
        assert choose_candidate_index(LineageFilter(type=[])) is None


class TestIsIndexExhaustive:
    def test_is_true_when_the_filter_has_no_predicate_beyond_the_chosen_candidate(self) -> None:
        assert is_index_exhaustive(
            LineageFilter(tenant="t"), LineageIndexCandidate("tenant", ["t"])
        )
        assert is_index_exhaustive(
            LineageFilter(type=["a", "b"]), LineageIndexCandidate("type", ["a", "b"])
        )

    def test_is_false_when_since_or_until_is_also_set(self) -> None:
        candidate = LineageIndexCandidate("tenant", ["t"])
        assert not is_index_exhaustive(LineageFilter(tenant="t", since="2026-01-01"), candidate)
        assert not is_index_exhaustive(LineageFilter(tenant="t", until="2026-01-01"), candidate)

    def test_is_false_when_another_field_is_also_set(self) -> None:
        assert not is_index_exhaustive(
            LineageFilter(type=["a"], tenant="t"), LineageIndexCandidate("type", ["a"])
        )
        assert not is_index_exhaustive(
            LineageFilter(intentHash="h", artifactId="a"),
            LineageIndexCandidate("intentHash", ["h"]),
        )

    def test_limit_alone_does_not_affect_exhaustiveness(self) -> None:
        assert is_index_exhaustive(
            LineageFilter(tenant="t", limit=5), LineageIndexCandidate("tenant", ["t"])
        )
