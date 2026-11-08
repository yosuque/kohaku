"""Cross-language golden for the Redis / Postgres adapters (Python side of `storageLayout` in
spec/test/fixtures/cross-language-canonical.json, generated from the TS adapters by
spec/scripts/storage-layout-fixtures.ts).

A TS host and a Python host can serve ONE Redis / Postgres, so what both must agree on without talking to each other
is pinned from the TS side: every Redis key, the lineage index entries and candidate-index choice, the Postgres DDL
text, the digest stored for an oversized correlation id, and the exact text of a stored record. This runs without
Docker; test_storage_interop.py (a TS process against a real backend) covers the same ground end to end.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from kohaku.spec import LineageFilter
from kohaku.storage._wire import (
    dumps_compact,
    fixation_from_wire,
    fixation_to_wire,
    lineage_from_wire,
    lineage_to_wire,
    promotion_from_wire,
    promotion_to_wire,
)
from kohaku.storage.postgres import (
    POSTGRES_SCHEMA_VERSION,
    correlation_column_value,
    lineage_correlation_ddl,
    postgres_schema_sql,
)
from kohaku.storage.redis import redis_keys, tenant_segment
from kohaku.storage.redis.lineage import (
    choose_candidate_index,
    index_values,
    is_index_exhaustive,
)

from ..conftest import load_cross_language_fixture

LAYOUT: dict[str, Any] = load_cross_language_fixture()["storageLayout"]


def test_the_fixture_is_non_trivial() -> None:
    assert len(LAYOUT["redis"]["keys"]) > 0
    assert len(LAYOUT["redis"]["indexValues"]) > 0
    assert len(LAYOUT["redis"]["candidates"]) > 0
    assert len(LAYOUT["postgres"]["schemas"]) > 0
    assert len(LAYOUT["postgres"]["correlationColumnValues"]) > 0
    assert len(LAYOUT["rows"]["lineage"]) > 0


class TestRedisLayout:
    @pytest.mark.parametrize(
        "case",
        LAYOUT["redis"]["keys"],
        ids=[f"{c['prefix']}|{c['tenant']}" for c in LAYOUT["redis"]["keys"]],
    )
    def test_every_key_matches_the_ts_adapter(self, case: dict[str, Any]) -> None:
        keys = redis_keys(case["prefix"])
        tenant = case["tenant"]
        assert tenant_segment(tenant) == case["tenantSegment"]
        assert keys.spec("k:1") == case["spec"]
        assert keys.promotion(tenant, "a1") == case["promotion"]
        assert keys.promotion_index(tenant) == case["promotionIndex"]
        assert keys.fixation(tenant, "sha256:ab") == case["fixation"]
        assert keys.fixation_index(tenant) == case["fixationIndex"]

    def test_the_fixed_keys_match_the_ts_adapter(self) -> None:
        keys = redis_keys()
        fixed = LAYOUT["redis"]["fixedKeys"]
        assert keys.lineage.seq == fixed["lineageSeq"]
        assert keys.lineage.events == fixed["lineageEvents"]
        assert keys.lineage.by_seq == fixed["lineageBySeq"]
        assert keys.lineage.index("type", "view.composed") == fixed["lineageIndexType"]
        assert keys.promotion_seq == fixed["promotionSeq"]
        assert keys.fixation_seq == fixed["fixationSeq"]
        assert keys.revoked("jti-1") == fixed["revoked"]

    @pytest.mark.parametrize("case", LAYOUT["redis"]["indexValues"])
    def test_a_lineage_event_contributes_the_same_index_entries(self, case: dict[str, Any]) -> None:
        event = lineage_from_wire(case["event"])
        assert [{"field": v.field, "value": v.value} for v in index_values(event)] == case[
            "expected"
        ]

    @pytest.mark.parametrize(
        "case", LAYOUT["redis"]["candidates"], ids=lambda c: json.dumps(c["filter"])
    )
    def test_a_lineage_filter_reads_from_the_same_index(self, case: dict[str, Any]) -> None:
        lineage_filter = LineageFilter(**case["filter"])
        candidate = choose_candidate_index(lineage_filter)
        if case["candidate"] is None:
            assert candidate is None
            assert case["exhaustive"] is None
            return
        assert candidate is not None
        assert {"field": candidate.field, "values": candidate.values} == case["candidate"]
        assert is_index_exhaustive(lineage_filter, candidate) == case["exhaustive"]


class TestPostgresLayout:
    def test_the_schema_version_matches(self) -> None:
        assert POSTGRES_SCHEMA_VERSION == LAYOUT["postgres"]["schemaVersion"]

    @pytest.mark.parametrize(
        "case",
        LAYOUT["postgres"]["schemas"],
        ids=[c["schema"][:20] for c in LAYOUT["postgres"]["schemas"]],
    )
    def test_the_ddl_is_byte_identical_to_the_ts_adapters(self, case: dict[str, Any]) -> None:
        assert postgres_schema_sql(case["schema"]) == case["sql"]
        ddl = lineage_correlation_ddl(case["schema"])
        expected = case["correlation"]
        assert ddl.column_name == expected["columnName"]
        assert ddl.index_name == expected["indexName"]
        assert ddl.add_column_sql == expected["addColumnSql"]
        assert ddl.guarded_add_column_sql == expected["guardedAddColumnSql"]
        assert ddl.create_index_sql == expected["createIndexSql"]
        assert ddl.create_index_concurrently_sql == expected["createIndexConcurrentlySql"]
        assert ddl.drop_index_concurrently_sql == expected["dropIndexConcurrentlySql"]

    @pytest.mark.parametrize(
        "case",
        LAYOUT["postgres"]["correlationColumnValues"],
        ids=[str(c["inputUtf16Length"]) for c in LAYOUT["postgres"]["correlationColumnValues"]],
    )
    def test_the_correlation_column_value_matches(self, case: dict[str, Any]) -> None:
        assert correlation_column_value(case["input"]) == case["expected"]


class TestStoredRecordText:
    @pytest.mark.parametrize("case", LAYOUT["rows"]["lineage"], ids=lambda c: c["event"]["type"])
    def test_a_lineage_event_is_stored_as_the_exact_ts_text(self, case: dict[str, Any]) -> None:
        event = lineage_from_wire(case["event"])
        assert dumps_compact(lineage_to_wire(event)) == case["text"]

    @pytest.mark.parametrize(
        "case", LAYOUT["rows"]["promotion"], ids=lambda c: c["record"]["artifactId"]
    )
    def test_a_promotion_state_is_stored_as_the_exact_ts_text(self, case: dict[str, Any]) -> None:
        state = promotion_from_wire(case["record"])
        assert dumps_compact(promotion_to_wire(state)) == case["text"]

    @pytest.mark.parametrize(
        "case",
        LAYOUT["rows"]["fixation"],
        ids=[str(i) for i in range(len(LAYOUT["rows"]["fixation"]))],
    )
    def test_a_fixation_is_stored_as_the_same_json_with_the_same_top_level_key_order(
        self, case: dict[str, Any]
    ) -> None:
        record = fixation_from_wire(case["record"])
        text = dumps_compact(fixation_to_wire(record))
        # The pinned Spec's own key order is the model's, not necessarily the example file's, so the whole text is
        # compared as data; the order of the record's own fields is the TS schema's.
        assert json.loads(text) == json.loads(case["text"])
        assert list(json.loads(text)) == list(json.loads(case["text"]))
        assert "pinnedSpec" in json.loads(text)
