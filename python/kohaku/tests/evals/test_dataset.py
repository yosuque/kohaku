"""Tests for the distillation dataset export (the TS-side packages/evals/test/dataset.test.ts as pytest)."""

from __future__ import annotations

import json
from typing import Any

from kohaku.evals import ColumnMeta, export_distillation_dataset
from kohaku.spec import FixationRecord, Principal, UISpec, parse_spec

_HASH_A = "sha256:" + "a" * 64
_HASH_B = "sha256:" + "b" * 64
_HASH_C = "sha256:" + "c" * 64

_APPROVER = Principal(id="user-1", name="Approver")


def _make_spec(intent_hash: str, ref: str) -> UISpec:
    return parse_spec(
        {
            "kohaku": "0.2",
            "intent": {"canonical": "sales.trend", "params": {"range": "q3"}, "hash": intent_hash},
            "dataVersion": "ledger@1",
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["chart"]},
                {
                    "id": "chart",
                    "type": "presentChart",
                    "props": {"kind": "line"},
                    "data": {"$ref": ref},
                },
            ],
            "events": [{"on": "chart.click", "emit": "intent.patch", "payload": {"drill": "$row.region"}}],
            "provenance": {"tier": "L1", "composedBy": "composer@0.1.0", "cache": "hit"},
        }
    )


def _make_fixation(
    intent_hash: str,
    ref: str,
    fixated_at: str,
    *,
    tenant: str | None = None,
    catalog_fingerprint: str | None = None,
) -> FixationRecord:
    return FixationRecord(
        intentHash=intent_hash,
        canonical="sales.trend",
        structureHash="sha256:" + intent_hash.split(":")[1],
        pinnedSpec=_make_spec(intent_hash, ref),
        fixatedAt=fixated_at,
        approver=_APPROVER,
        tenant=tenant,
        catalogFingerprint=catalog_fingerprint,
    )


def _lines(jsonl: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in jsonl.split("\n") if line != ""]


def test_emits_one_line_per_spec_sorted_by_intent_hash_ascending() -> None:
    fixations = [
        _make_fixation(_HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z"),
        _make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z"),
    ]
    jsonl = export_distillation_dataset(fixations)
    records = _lines(jsonl)
    assert len(records) == 2
    assert jsonl.endswith("\n")
    assert records[0]["meta"]["fixatedAt"] == "2026-01-01T00:00:00Z"
    assert records[1]["meta"]["fixatedAt"] == "2026-01-02T00:00:00Z"


def test_records_only_components_and_events_under_target() -> None:
    jsonl = export_distillation_dataset([_make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")])
    record = json.loads(jsonl.strip())
    assert record["source"] == "fixation"
    assert record["intent"] == {"canonical": "sales.trend", "params": {"range": "q3"}}
    assert record["refs"] == ["query://ledger/a"]
    assert record["meta"] == {
        "fixatedAt": "2026-01-01T00:00:00Z",
        "structureHash": "sha256:" + _HASH_A.split(":")[1],
    }
    assert list(record.keys()) == ["intent", "meta", "refs", "source", "target"]  # canonical key order (deep-sorted)
    assert list(record["target"].keys()) == ["components", "events"]
    assert len(record["target"]["components"]) == 2
    assert len(record["target"]["events"]) == 1


def test_includes_golden_specs_keyed_by_intent_hash_with_empty_meta() -> None:
    golden = [_make_spec(_HASH_C, "query://ledger/c")]
    jsonl = export_distillation_dataset([], golden)
    record = json.loads(jsonl.strip())
    assert record["source"] == "golden"
    assert record["meta"] == {}
    assert record["refs"] == ["query://ledger/c"]


def test_interleaves_fixation_and_golden_entries_in_intent_hash_order() -> None:
    jsonl = export_distillation_dataset(
        [_make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")],
        [_make_spec(_HASH_B, "query://ledger/b")],
    )
    sources = [r["source"] for r in _lines(jsonl)]
    assert sources == ["fixation", "golden"]


def test_dedupes_refs_across_components_preserving_first_occurrence_order() -> None:
    spec = _make_spec(_HASH_A, "query://ledger/a")
    extra = parse_spec(
        {
            "kohaku": spec.kohaku,
            "intent": spec.intent.to_wire(),
            "dataVersion": spec.dataVersion,
            "components": [
                *[c.to_wire() for c in spec.components],
                {"id": "table", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": "query://ledger/a"}},
                {"id": "chart2", "type": "presentChart", "props": {}, "data": {"$ref": "query://ledger/z"}},
            ],
            "events": [e.to_wire() for e in spec.events],
            "provenance": spec.provenance.to_wire(),
        }
    )
    jsonl = export_distillation_dataset([], [extra])
    record = json.loads(jsonl.strip())
    assert record["refs"] == ["query://ledger/a", "query://ledger/z"]


def test_adds_shape_only_when_describe_shape_returns_a_value() -> None:
    jsonl = export_distillation_dataset(
        [_make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")],
        describe_shape=lambda intent: [ColumnMeta(name="region", type="string")]
        if intent.canonical == "sales.trend"
        else None,
    )
    record = json.loads(jsonl.strip())
    assert record["shape"] == [{"name": "region", "type": "string"}]


def test_omits_shape_when_describe_shape_returns_none() -> None:
    jsonl = export_distillation_dataset(
        [_make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")],
        describe_shape=lambda intent: None,
    )
    record = json.loads(jsonl.strip())
    assert "shape" not in record


def test_returns_empty_string_for_empty_input() -> None:
    assert export_distillation_dataset([]) == ""


def test_deterministic_same_input_reproduces_byte_identical_output() -> None:
    fixations = [
        _make_fixation(_HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z"),
        _make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z"),
    ]
    golden = [_make_spec(_HASH_C, "query://ledger/c")]
    assert export_distillation_dataset(fixations, golden) == export_distillation_dataset(fixations, golden)


def test_populates_meta_tenant_and_catalog_fingerprint_when_present() -> None:
    fixations = [
        _make_fixation(
            _HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z", tenant="tenant-a", catalog_fingerprint="cat-1"
        )
    ]
    record = json.loads(export_distillation_dataset(fixations).strip())
    assert record["meta"] == {
        "fixatedAt": "2026-01-01T00:00:00Z",
        "structureHash": "sha256:" + _HASH_A.split(":")[1],
        "tenant": "tenant-a",
        "catalogFingerprint": "cat-1",
    }


def test_omits_meta_tenant_and_catalog_fingerprint_when_the_record_predates_them() -> None:
    fixations = [_make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")]
    record = json.loads(export_distillation_dataset(fixations).strip())
    assert sorted(record["meta"].keys()) == ["fixatedAt", "structureHash"]


def test_keeps_golden_meta_empty_even_for_the_same_intent_hash_as_a_fixation() -> None:
    golden = [_make_spec(_HASH_A, "query://ledger/a")]
    record = json.loads(export_distillation_dataset([], golden).strip())
    assert record["meta"] == {}


def test_tenant_filters_fixations_leaving_golden_entries_untouched() -> None:
    fixations = [
        _make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z", tenant="tenant-a"),
        _make_fixation(_HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z", tenant="tenant-b"),
    ]
    golden = [_make_spec(_HASH_C, "query://ledger/c")]
    jsonl = export_distillation_dataset(fixations, golden, tenant="tenant-a")
    records = _lines(jsonl)
    assert len(records) == 2
    assert [r["source"] for r in records] == ["fixation", "golden"]
    assert records[0]["meta"]["tenant"] == "tenant-a"


def test_without_tenant_every_tenant_present_is_included() -> None:
    fixations = [
        _make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z", tenant="tenant-a"),
        _make_fixation(_HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z", tenant="tenant-b"),
    ]
    assert len(_lines(export_distillation_dataset(fixations))) == 2


def test_breaks_a_same_intent_hash_tie_with_fixation_before_golden() -> None:
    # Same intentHash on both sides so the sort key alone cannot order them: the tie-break must be explicit.
    fixations = [_make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")]
    golden = [_make_spec(_HASH_A, "query://ledger/a")]
    records = _lines(export_distillation_dataset(fixations, golden))
    assert len(records) == 2
    assert [r["source"] for r in records] == ["fixation", "golden"]


def test_shape_projects_to_exactly_name_type_description() -> None:
    fixations = [_make_fixation(_HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")]
    jsonl = export_distillation_dataset(
        fixations, describe_shape=lambda intent: [ColumnMeta(name="region", type="string")]
    )
    record = json.loads(jsonl.strip())
    assert record["shape"] == [{"name": "region", "type": "string"}]
    assert sorted(record["shape"][0].keys()) == ["name", "type"]
