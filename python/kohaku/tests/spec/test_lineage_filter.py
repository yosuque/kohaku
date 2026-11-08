"""Tests for kohaku.spec.lineage_filter (port of packages/spec-core/test/lineage-filter.test.ts): the shared
per-event predicate, the payload index fields and the tail-window helper every StoragePort builds on."""

from __future__ import annotations

from kohaku.spec import (
    DEFAULT_LINEAGE_LIMIT,
    LINEAGE_PAYLOAD_INDEX_FIELDS,
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    apply_lineage_limit,
    matches_lineage_filter,
    normalize_tenant,
)


def _event(
    type_: str, payload: dict[str, object], ts: str, tenant: str | None = None
) -> LineageEventRecord:
    return LineageEventRecord(
        id=f"{type_}:{ts}:{tenant or ''}",
        ts=ts,
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload,
        tenant=tenant,
    )


class TestLineagePayloadIndexFields:
    def test_lists_exactly_the_payload_fields_matches_lineage_filter_reads(self) -> None:
        assert LINEAGE_PAYLOAD_INDEX_FIELDS == (
            "intentHash",
            "artifactId",
            "specHash",
            "correlationId",
        )


class TestMatchesLineageFilter:
    e = _event(
        "view.composed",
        {"intentHash": "h1", "artifactId": "a1", "specHash": "s1", "correlationId": "c1"},
        "2026-01-02T00:00:00.000Z",
        "t1",
    )

    def test_matches_an_empty_filter(self) -> None:
        assert matches_lineage_filter(self.e, LineageFilter())

    def test_filters_by_type_membership(self) -> None:
        assert matches_lineage_filter(self.e, LineageFilter(type=["view.composed"]))
        assert not matches_lineage_filter(self.e, LineageFilter(type=["component.used"]))

    def test_filters_by_payload_equality(self) -> None:
        for field, good in [
            ("intentHash", "h1"),
            ("artifactId", "a1"),
            ("specHash", "s1"),
            ("correlationId", "c1"),
        ]:
            assert matches_lineage_filter(self.e, LineageFilter(**{field: good}))  # type: ignore[arg-type]
            assert not matches_lineage_filter(self.e, LineageFilter(**{field: "other"}))  # type: ignore[arg-type]

    def test_applies_since_and_until_inclusively(self) -> None:
        assert matches_lineage_filter(self.e, LineageFilter(since="2026-01-02T00:00:00.000Z"))
        assert not matches_lineage_filter(self.e, LineageFilter(since="2026-01-03T00:00:00.000Z"))
        assert matches_lineage_filter(self.e, LineageFilter(until="2026-01-02T00:00:00.000Z"))
        assert not matches_lineage_filter(self.e, LineageFilter(until="2026-01-01T00:00:00.000Z"))

    def test_matches_tenant_by_equality_after_normalization_on_both_sides(self) -> None:
        assert matches_lineage_filter(self.e, LineageFilter(tenant="t1"))
        assert not matches_lineage_filter(self.e, LineageFilter(tenant="t2"))

    def test_treats_an_empty_string_filter_tenant_as_unspecified(self) -> None:
        assert matches_lineage_filter(self.e, LineageFilter(tenant=""))
        tenantless = _event("view.composed", {}, "2026-01-02T00:00:00.000Z")
        assert matches_lineage_filter(tenantless, LineageFilter(tenant=""))

    def test_treats_an_empty_string_event_tenant_as_no_tenant(self) -> None:
        empty = _event("view.composed", {}, "2026-01-02T00:00:00.000Z", "")
        assert matches_lineage_filter(empty, LineageFilter(tenant=None))
        assert not matches_lineage_filter(empty, LineageFilter(tenant="t1"))


class TestApplyLineageLimit:
    items = [1, 2, 3, 4, 5]

    def test_defaults_to_the_default_limit(self) -> None:
        assert DEFAULT_LINEAGE_LIMIT == 200
        assert apply_lineage_limit(self.items) == self.items

    def test_returns_the_tail_in_original_order(self) -> None:
        assert apply_lineage_limit(self.items, 2) == [4, 5]

    def test_returns_everything_when_limit_exceeds_the_length(self) -> None:
        assert apply_lineage_limit(self.items, 100) == self.items

    def test_returns_an_empty_list_for_limit_zero_or_negative(self) -> None:
        assert apply_lineage_limit(self.items, 0) == []
        assert apply_lineage_limit(self.items, -1) == []


def test_normalize_tenant_collapses_none_and_empty() -> None:
    assert normalize_tenant(None) is None
    assert normalize_tenant("") is None
    assert normalize_tenant("a") == "a"
