"""Tests for the domain aggregation queries (port of TS: apps/sample-api/test/queries.test.ts).

Checks deterministic aggregation from the seed, server-side paging/sorting, display labels, the missing-value
convention, the KPI scope contract, metric propagation, and topN clamping.
"""

from __future__ import annotations

from sales_api.domain import (
    CHANNEL_LABELS,
    REGION_LABELS,
    SalesRepo,
    kpi,
    records,
    shape_of,
    summary,
    targets,
    trend,
)


def _sorted_desc(xs: list[float]) -> list[float]:
    return sorted(xs, reverse=True)


class TestRecordsPaging:
    """records()'s server-side paging/sorting contract."""

    def test_no_reserved_params_is_legacy(self) -> None:
        repo = SalesRepo()
        dv = repo.data_version()
        all_ = records(repo, {})
        assert len(all_.rows) == 100
        assert all_.total is not None and all_.total > 100
        assert all_.nextCursor == f"100:_:{dv}"

    def test_limit_cursor_pagination_concatenates(self) -> None:
        repo = SalesRepo()
        dv = repo.data_version()
        whole = records(repo, {"_limit": "20"})
        page1 = records(repo, {"_limit": "10"})
        assert len(page1.rows) == 10
        assert page1.nextCursor == f"10:_:{dv}"
        page2 = records(repo, {"_limit": "10", "_cursor": page1.nextCursor})
        assert len(page2.rows) == 10
        assert page1.rows + page2.rows == whole.rows

    def test_huge_limit_clamped_to_500(self) -> None:
        repo = SalesRepo()
        dv = repo.data_version()
        total = records(repo, {}).total
        assert total is not None and total > 500
        clamped = records(repo, {"_limit": "100000"})
        assert len(clamped.rows) == 500
        assert clamped.nextCursor == f"500:_:{dv}"
        last = records(repo, {"_limit": "100000", "_cursor": f"500:_:{dv}"})
        assert len(last.rows) == total - 500
        assert last.nextCursor is None

    def test_limit_non_positive_falls_back_to_100(self) -> None:
        repo = SalesRepo()
        assert len(records(repo, {"_limit": "0"}).rows) == 100
        assert len(records(repo, {"_limit": "-5"}).rows) == 100
        assert len(records(repo, {"_limit": "abc"}).rows) == 100

    def test_legacy_limit_also_clamped(self) -> None:
        repo = SalesRepo()
        total = records(repo, {}).total
        assert total is not None and total > 500
        assert len(records(repo, {"limit": "999999"}).rows) == 500
        assert len(records(repo, {"limit": "10"}).rows) == 10

    def test_sort_dir_column_sort(self) -> None:
        repo = SalesRepo()
        desc = [
            r["revenue"] for r in records(repo, {"_limit": "8", "_sort": "revenue", "_dir": "desc"}).rows
        ]
        assert _sorted_desc(desc) == desc  # type: ignore[arg-type]
        asc = [
            r["revenue"] for r in records(repo, {"_limit": "8", "_sort": "revenue", "_dir": "asc"}).rows
        ]
        assert sorted(asc) == asc  # type: ignore[type-var]

    def test_unknown_sort_column_is_noop(self) -> None:
        repo = SalesRepo()
        default = records(repo, {"_limit": "10"}).rows
        unknown = records(repo, {"_limit": "10", "_sort": "does_not_exist"}).rows
        assert unknown == default

    def test_version_mismatch_cursor_resets(self) -> None:
        repo = SalesRepo()
        page1 = records(repo, {"_limit": "10"}).rows
        stale = records(repo, {"_limit": "10", "_cursor": "10:_:some-old-version"}).rows
        assert stale == page1

    def test_legacy_two_part_cursor_resets(self) -> None:
        repo = SalesRepo()
        dv = repo.data_version()
        page1 = records(repo, {"_limit": "10"}).rows
        legacy = records(repo, {"_limit": "10", "_cursor": f"10:{dv}"}).rows
        assert legacy == page1

    def test_next_cursor_embeds_sort_signature(self) -> None:
        repo = SalesRepo()
        dv = repo.data_version()
        sorted_ = records(repo, {"_limit": "10", "_sort": "revenue", "_dir": "asc"})
        assert sorted_.nextCursor == f"10:revenue.asc:{dv}"

    def test_same_sort_cursor_continues(self) -> None:
        repo = SalesRepo()
        whole = records(repo, {"_limit": "20", "_sort": "revenue", "_dir": "asc"})
        page1 = records(repo, {"_limit": "10", "_sort": "revenue", "_dir": "asc"})
        page2 = records(
            repo, {"_limit": "10", "_sort": "revenue", "_dir": "asc", "_cursor": page1.nextCursor}
        )
        assert page1.rows + page2.rows == whole.rows

    def test_changed_sort_context_resets(self) -> None:
        repo = SalesRepo()
        asc_page1 = records(repo, {"_limit": "10", "_sort": "revenue", "_dir": "asc"})
        desc_reset = records(
            repo,
            {"_limit": "10", "_sort": "revenue", "_dir": "desc", "_cursor": asc_page1.nextCursor},
        )
        desc_page1 = records(repo, {"_limit": "10", "_sort": "revenue", "_dir": "desc"})
        assert desc_reset.rows == desc_page1.rows

    def test_changed_sort_column_resets(self) -> None:
        repo = SalesRepo()
        by_revenue = records(repo, {"_limit": "10", "_sort": "revenue", "_dir": "desc"})
        by_units_reset = records(
            repo,
            {"_limit": "10", "_sort": "units", "_dir": "desc", "_cursor": by_revenue.nextCursor},
        )
        by_units_page1 = records(repo, {"_limit": "10", "_sort": "units", "_dir": "desc"})
        assert by_units_reset.rows == by_units_page1.rows

    def test_default_and_reserved_cursors_are_mutually_invalid(self) -> None:
        repo = SalesRepo()
        default_page1 = records(repo, {"_limit": "10"})
        crossed = records(
            repo,
            {"_limit": "10", "_sort": "revenue", "_dir": "asc", "_cursor": default_page1.nextCursor},
        )
        asc_page1 = records(repo, {"_limit": "10", "_sort": "revenue", "_dir": "asc"})
        assert crossed.rows == asc_page1.rows


class TestDisplayLabelsAndScope:
    """Display labels / missing values / unit-label unification / KPI scope contract."""

    def test_summary_region_uses_display_labels(self) -> None:
        repo = SalesRepo()
        region_labels = set(REGION_LABELS.values())
        t = summary(repo, {"fy": 2026, "q": 3, "groupBy": "region"})
        assert [c.key for c in t.columns] == ["region", "revenue", "units"]
        for row in t.rows:
            assert row["region"] in region_labels
            assert row["region"] not in ("japan", "north_america", "europe", "apac")

    def test_summary_channel_uses_labels(self) -> None:
        repo = SalesRepo()
        channel_labels = set(CHANNEL_LABELS.values())
        t = summary(repo, {"fy": 2026, "q": 3, "groupBy": "channel"})
        assert len(t.rows) > 0
        for row in t.rows:
            assert row["channel"] in channel_labels

    def test_records_labels_and_units_label(self) -> None:
        repo = SalesRepo()
        region_labels = set(REGION_LABELS.values())
        channel_labels = set(CHANNEL_LABELS.values())
        t = records(repo, {"_limit": "30"})
        for row in t.rows:
            assert row["region"] in region_labels
            assert row["channel"] in channel_labels
            assert row["region"] not in ("japan", "north_america", "europe", "apac")
        units_col = next(c for c in t.columns if c.key == "units")
        assert units_col.label == "Units"

    def test_targets_region_label(self) -> None:
        repo = SalesRepo()
        region_labels = set(REGION_LABELS.values())
        t = targets(repo, {"fy": 2026, "q": 2})
        assert len(t.rows) > 0
        for row in t.rows:
            assert row["region"] in region_labels

    def test_kpi_yoy_missing_prior_is_null(self) -> None:
        repo = SalesRepo()
        row = kpi(repo, {"metric": "yoy", "fy": 2025}).rows[0]
        assert row["value"] is None
        assert "No baseline data" in str(row["note"])

    def test_kpi_yoy_present_prior_is_number(self) -> None:
        repo = SalesRepo()
        row = kpi(repo, {"metric": "yoy", "fy": 2026}).rows[0]
        assert isinstance(row["value"], (int, float)) and not isinstance(row["value"], bool)

    def test_kpi_target_attainment_missing_target_is_null(self) -> None:
        repo = SalesRepo()
        row = kpi(repo, {"metric": "target_attainment", "fy": 2099}).rows[0]
        assert row["value"] is None
        assert "No target set" in str(row["note"])

    def test_kpi_ignores_dimension_filter(self) -> None:
        repo = SalesRepo()
        all_ = kpi(repo, {"metric": "total_revenue", "fy": 2026}).rows[0]
        with_region = kpi(repo, {"metric": "total_revenue", "fy": 2026, "region": "japan"}).rows[0]
        assert with_region["value"] == all_["value"]


class TestSummaryMetric:
    """summary()'s metric (the basis for sorting and topN)."""

    def test_default_and_revenue_are_revenue_desc(self) -> None:
        repo = SalesRepo()
        default = summary(repo, {"fy": 2026, "groupBy": "product"}).rows
        explicit = summary(repo, {"fy": 2026, "groupBy": "product", "metric": "revenue"}).rows
        assert explicit == default
        values = [r["revenue"] for r in default]
        assert _sorted_desc(values) == values  # type: ignore[arg-type]

    def test_units_metric_sorts_by_units(self) -> None:
        repo = SalesRepo()
        rows = summary(repo, {"fy": 2026, "groupBy": "product", "metric": "units"}).rows
        assert len(rows) > 1
        values = [r["units"] for r in rows]
        assert _sorted_desc(values) == values  # type: ignore[arg-type]

    def test_seed_units_vs_revenue_ranking_differs(self) -> None:
        repo = SalesRepo()
        by_revenue = [r["product"] for r in summary(repo, {"fy": 2026, "groupBy": "product"}).rows]
        by_units = [
            r["product"]
            for r in summary(repo, {"fy": 2026, "groupBy": "product", "metric": "units"}).rows
        ]
        assert by_revenue[0] == "Aurora CRM"
        assert by_units[0] == "EdgeSight Sensor"
        assert by_units != by_revenue

    def test_top_n_uses_metric_basis(self) -> None:
        repo = SalesRepo()
        top_units = summary(
            repo, {"fy": 2026, "groupBy": "product", "metric": "units", "topN": "1"}
        ).rows
        assert len(top_units) == 1
        assert top_units[0]["product"] == "EdgeSight Sensor"
        top_revenue = summary(repo, {"fy": 2026, "groupBy": "product", "topN": "1"}).rows
        assert top_revenue[0]["product"] == "Aurora CRM"

    def test_unknown_metric_falls_back_to_revenue(self) -> None:
        repo = SalesRepo()
        default = summary(repo, {"fy": 2026, "groupBy": "product"}).rows
        assert summary(repo, {"fy": 2026, "groupBy": "product", "metric": "bogus"}).rows == default


class TestTrendMetric:
    """trend()'s metric normalization (symmetric with summary. M1). Unknown values fall back to revenue."""

    def test_default_metric_keys_revenue(self) -> None:
        repo = SalesRepo()
        rows = trend(repo, {"fy": 2026}).rows
        assert rows and all("revenue" in r for r in rows)

    def test_units_metric_keys_units(self) -> None:
        repo = SalesRepo()
        rows = trend(repo, {"fy": 2026, "metric": "units"}).rows
        assert rows and all("units" in r for r in rows)

    def test_unknown_metric_falls_back_to_revenue(self) -> None:
        repo = SalesRepo()
        default = trend(repo, {"fy": 2026}).rows
        bogus = trend(repo, {"fy": 2026, "metric": "bogus"}).rows
        # An unknown metric is normalized to revenue and exactly matches the default (revenue).
        assert bogus == default
        # The row key is "revenue", not the unknown "bogus" (consistent with the output columns / aggregated values).
        assert all("revenue" in r and "bogus" not in r for r in bogus)

    def test_shape_of_matches_trend_for_unknown_metric(self) -> None:
        repo = SalesRepo()
        args = {"fy": 2026, "granularity": "month", "metric": "bogus"}
        actual = trend(repo, args)
        shape = shape_of("trend", args)
        assert shape is not None
        assert [c.name for c in shape.columns] == [c.key for c in actual.columns]


class TestTargetsMissing:
    """targets()'s attainment missing-value convention."""

    def test_zero_target_row_is_null_attainment(self) -> None:
        repo = SalesRepo()
        # The seed has no target of 0, so we synthesize a target-0 row for a non-existent (fy, q) to exercise the missing-value path.
        from sales_api.domain import SalesTarget

        repo.targets.append(
            SalesTarget(fiscal_year=2027, quarter=1, region="japan", target_revenue=0)
        )
        t = targets(repo, {"fy": 2027, "q": 1})
        assert len(t.rows) == 1
        row = t.rows[0]
        assert row["attainment"] is None
        assert "No target set" in str(row["note"])

    def test_normal_row_has_number_attainment_and_null_note(self) -> None:
        repo = SalesRepo()
        t = targets(repo, {"fy": 2026, "q": 2})
        assert [c.key for c in t.columns] == ["region", "actual", "target", "attainment", "note"]
        assert len(t.rows) > 0
        for row in t.rows:
            assert isinstance(row["attainment"], (int, float)) and not isinstance(
                row["attainment"], bool
            )
            assert row["note"] is None


class TestTopNClamp:
    """summary()'s topN clamp (boundary)."""

    def test_valid_top_n(self) -> None:
        repo = SalesRepo()
        t = summary(repo, {"fy": 2026, "groupBy": "product", "topN": "2"})
        assert len(t.rows) == 2

    def test_zero_negative_nonnumeric_returns_all(self) -> None:
        repo = SalesRepo()
        full = len(summary(repo, {"fy": 2026, "groupBy": "product"}).rows)
        assert full > 1
        assert len(summary(repo, {"fy": 2026, "groupBy": "product", "topN": "0"}).rows) == full
        assert len(summary(repo, {"fy": 2026, "groupBy": "product", "topN": "-3"}).rows) == full
        assert len(summary(repo, {"fy": 2026, "groupBy": "product", "topN": "abc"}).rows) == full


class TestDataVersion:
    """dataVersion (derived from the seed contentHash) is the same string as TS and advances with bump/annotate."""

    def test_data_version_matches_seed(self) -> None:
        repo = SalesRepo()
        assert repo.data_version() == "sales@seed-20260610.1+ade3e9a0a5de#bump-0"

    def test_bump_and_annotate_advance_version(self) -> None:
        repo = SalesRepo()
        assert repo.bump() == "sales@seed-20260610.1+ade3e9a0a5de#bump-1"
        assert repo.annotate("memo") == "sales@seed-20260610.1+ade3e9a0a5de#bump-2"
        assert repo.notes == ["memo"]
