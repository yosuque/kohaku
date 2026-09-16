"""Invariant test for domain.py's fiscal_year_of / quarter_of against the seed (port of TS:
apps/sample-api/test/domain-types.test.ts).

fiscal_year_of/quarter_of are the single source scripts/generate-seed.ts (TS) and semantic_port.py's
fiscal_period_of both draw from (directly or via the TS mirror). This checks every seed record's own
fiscal_year/quarter, derived independently from its calendar month string, still agrees with them —
the cross-check that would catch a regeneration bug or a helper/seed convention drift.
"""

from __future__ import annotations

from sales_api.domain import SalesRepo, fiscal_year_of, quarter_of


class TestFiscalYearOfQuarterOfAgainstSeed:
    def test_seed_has_expected_row_count(self) -> None:
        repo = SalesRepo()
        assert len(repo.records) == 576  # 2 fiscal years x 12 months x 4 regions x 6 products

    def test_every_record_matches_fiscal_year_of_and_quarter_of(self) -> None:
        repo = SalesRepo()
        assert len(repo.records) > 0
        for r in repo.records:
            cal_year_str, cal_month_str = r.month.split("-")
            cal_year = int(cal_year_str)
            cal_month = int(cal_month_str)
            assert fiscal_year_of(cal_year, cal_month) == r.fiscal_year
            assert quarter_of(cal_month) == r.quarter

    def test_boundary_values(self) -> None:
        # Mar 31 -> prior FY Q4, Apr 1 -> this FY Q1.
        assert fiscal_year_of(2026, 3) == 2025
        assert quarter_of(3) == 4
        assert fiscal_year_of(2026, 4) == 2026
        assert quarter_of(4) == 1
