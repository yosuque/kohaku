import { describe, expect, it } from "vitest";
import { kpi, records, shapeOf, summary, targets, trend } from "../src/domain/queries.js";
import { SalesRepo } from "../src/domain/repo.js";
import { CHANNEL_LABELS, REGION_LABELS } from "../src/domain/types.js";

// records() server-side paging/sort contract.
// Also regression-checks that, when the reserved parameters (_limit/_cursor/_sort/_dir) are unspecified, behavior is identical to the default.
describe("records() server-side paging/sort", () => {
  const repo = new SalesRepo();
  const dv = repo.dataVersion();

  it("without reserved params applies the default (first limit=100, nextCursor if more)", () => {
    const all = records(repo, {});
    expect(all.rows.length).toBe(100);
    expect(all.total!).toBeGreaterThan(100);
    // Since there is more, returns the next-page cursor (offset 100 + sort signature (default "_") + version).
    expect(all.nextCursor).toBe(`100:_:${dv}`);
  });

  it("_limit/_cursor paginates, and concatenation matches the full page", () => {
    const whole = records(repo, { _limit: "20" });
    const page1 = records(repo, { _limit: "10" });
    expect(page1.rows).toHaveLength(10);
    expect(page1.nextCursor).toBe(`10:_:${dv}`);

    const page2 = records(repo, { _limit: "10", _cursor: page1.nextCursor! });
    expect(page2.rows).toHaveLength(10);
    // No duplication or omission across pages.
    expect([...page1.rows, ...page2.rows]).toEqual(whole.rows);
  });

  it("a huge _limit is clamped to 500 to prevent a full fetch (the last page has no nextCursor)", () => {
    const total = records(repo, {}).total!;
    // The seed has 500 < total <= 1000 (576 records). Even with _limit=100000, a page is capped at 500 records.
    expect(total).toBeGreaterThan(500);
    const clamped = records(repo, { _limit: "100000" });
    expect(clamped.rows).toHaveLength(500);
    // Since there is still more, returns the next-page cursor (offset 500 + sort signature + version).
    expect(clamped.nextCursor).toBe(`500:_:${dv}`);
    // The continuation (from 500 on) is the remaining total-500 records, which fit in one page, so no nextCursor is returned.
    const last = records(repo, { _limit: "100000", _cursor: `500:_:${dv}` });
    expect(last.rows).toHaveLength(total - 500);
    expect(last.nextCursor).toBeUndefined();
  });

  it("_limit of <= 0 or non-number falls back to the default (100)", () => {
    // A _limit invalidated by clamping falls back to the "no reserved parameter" case and returns to the legacy default of 100.
    expect(records(repo, { _limit: "0" }).rows).toHaveLength(100);
    expect(records(repo, { _limit: "-5" }).rows).toHaveLength(100);
    expect(records(repo, { _limit: "abc" }).rows).toHaveLength(100);
  });

  it("the legacy limit fallback is also clamped to 1-500 (999999 -> 500)", () => {
    const total = records(repo, {}).total!;
    expect(total).toBeGreaterThan(500);
    // The legacy limit parameter has no clamp of its own and could fetch everything unbounded; round it to the same cap as _limit.
    expect(records(repo, { limit: "999999" }).rows).toHaveLength(500);
    // A valid legacy limit still takes effect as-is (regression).
    expect(records(repo, { limit: "10" }).rows).toHaveLength(10);
  });

  it("_sort/_dir sorts by column (revenue ascending/descending)", () => {
    const desc = records(repo, { _limit: "8", _sort: "revenue", _dir: "desc" }).rows.map(
      (r) => r["revenue"] as number,
    );
    expect([...desc].sort((a, b) => b - a)).toEqual(desc);

    const asc = records(repo, { _limit: "8", _sort: "revenue", _dir: "asc" }).rows.map(
      (r) => r["revenue"] as number,
    );
    expect([...asc].sort((a, b) => a - b)).toEqual(asc);
  });

  it("_sort/_dir sorts a string column too (region ascending/descending; the label-mapped column is sorted by label)", () => {
    const asc = records(repo, { _limit: "8", _sort: "region", _dir: "asc" }).rows.map((r) =>
      String(r["region"]),
    );
    expect([...asc].sort((a, b) => a.localeCompare(b))).toEqual(asc);

    const desc = records(repo, { _limit: "8", _sort: "region", _dir: "desc" }).rows.map((r) =>
      String(r["region"]),
    );
    expect([...desc].sort((a, b) => b.localeCompare(a))).toEqual(desc);

    // The page windows of asc and desc start from opposite ends (proves the sign is applied to the string comparison).
    expect(asc[0]).not.toBe(desc[0]);
  });

  it("an unknown _sort column keeps the default order (no-op)", () => {
    const def = records(repo, { _limit: "10" }).rows;
    const unknown = records(repo, { _limit: "10", _sort: "does_not_exist" }).rows;
    expect(unknown).toEqual(def);
  });

  it("a version-mismatched _cursor resets to the first page", () => {
    const page1 = records(repo, { _limit: "10" }).rows;
    // Correct format but stale version only (3-element cursor).
    const stale = records(repo, { _limit: "10", _cursor: `10:_:some-old-version` }).rows;
    expect(stale).toEqual(page1);
  });

  it("a legacy two-element cursor without a sort signature resets to the first page", () => {
    const page1 = records(repo, { _limit: "10" }).rows;
    // The legacy format `offset:dataVersion` (a single ':') is treated as invalid by the current parser -> resets to the first page.
    const legacy = records(repo, { _limit: "10", _cursor: `10:${dv}` }).rows;
    expect(legacy).toEqual(page1);
  });

  it("nextCursor embeds the sort signature (when _sort/_dir is given)", () => {
    const sorted = records(repo, { _limit: "10", _sort: "revenue", _dir: "asc" });
    expect(sorted.nextCursor).toBe(`10:revenue.asc:${dv}`);
  });

  it("a same-sort _cursor continues paging (no duplicates or gaps)", () => {
    const whole = records(repo, { _limit: "20", _sort: "revenue", _dir: "asc" });
    const page1 = records(repo, { _limit: "10", _sort: "revenue", _dir: "asc" });
    expect(page1.nextCursor).toBe(`10:revenue.asc:${dv}`);
    const page2 = records(repo, {
      _limit: "10",
      _sort: "revenue",
      _dir: "asc",
      _cursor: page1.nextCursor!,
    });
    expect([...page1.rows, ...page2.rows]).toEqual(whole.rows);
  });

  it("a _cursor with a changed sort context resets to the first page", () => {
    // Fetch the first page in ascending revenue order (the cursor embeds revenue.asc).
    const ascPage1 = records(repo, { _limit: "10", _sort: "revenue", _dir: "asc" });
    // Request the second page with the same cursor but flipping the direction to descending -> signature mismatch resets offset to 0.
    const descReset = records(repo, {
      _limit: "10",
      _sort: "revenue",
      _dir: "desc",
      _cursor: ascPage1.nextCursor!,
    });
    // Matches the descending first page (offset 0) (does not continue from the ascending second page).
    const descPage1 = records(repo, { _limit: "10", _sort: "revenue", _dir: "desc" });
    expect(descReset.rows).toEqual(descPage1.rows);
  });

  it("a _cursor with a changed sort column also resets to the first page", () => {
    const byRevenue = records(repo, { _limit: "10", _sort: "revenue", _dir: "desc" });
    // Reuse the revenue-descending cursor for a units-descending request -> signature mismatch resets.
    const byUnitsReset = records(repo, {
      _limit: "10",
      _sort: "units",
      _dir: "desc",
      _cursor: byRevenue.nextCursor!,
    });
    const byUnitsPage1 = records(repo, { _limit: "10", _sort: "units", _dir: "desc" });
    expect(byUnitsReset.rows).toEqual(byUnitsPage1.rows);
  });

  it("cursors of the default sort (signature '_') and a reserved sort are mutually invalid (prevents mix-ups)", () => {
    const defaultPage1 = records(repo, { _limit: "10" }); // signature "_"
    // Using the default cursor for a revenue.asc request causes a signature mismatch -> resets to the first page.
    const crossed = records(repo, {
      _limit: "10",
      _sort: "revenue",
      _dir: "asc",
      _cursor: defaultPage1.nextCursor!,
    });
    const ascPage1 = records(repo, { _limit: "10", _sort: "revenue", _dir: "asc" });
    expect(crossed.rows).toEqual(ascPage1.rows);
  });
});

// Display labels / missing values / unit label unification / KPI scope contract.
describe("display labels, missing values, KPI scope", () => {
  const repo = new SalesRepo();
  const regionLabels = Object.values(REGION_LABELS);
  const regionCodes = ["japan", "north_america", "europe", "apac"];
  const channelLabels = Object.values(CHANNEL_LABELS);

  it("summary(region) makes cell values display labels (column keys stay as codes)", () => {
    const t = summary(repo, { fy: 2026, q: 3, groupBy: "region" });
    expect(t.columns.map((c) => c.key)).toEqual(["region", "revenue", "units"]);
    for (const row of t.rows) {
      expect(regionLabels).toContain(row["region"]);
      expect(regionCodes).not.toContain(row["region"]);
    }
  });

  it("summary(channel) makes cell values display channel labels", () => {
    const t = summary(repo, { fy: 2026, q: 3, groupBy: "channel" });
    expect(t.rows.length).toBeGreaterThan(0);
    for (const row of t.rows) expect(channelLabels).toContain(row["channel"]);
  });

  it("records() labels region / channel with display labels and unifies the units column label", () => {
    const t = records(repo, { _limit: "30" });
    for (const row of t.rows) {
      expect(regionLabels).toContain(row["region"]);
      expect(channelLabels).toContain(row["channel"]);
      expect(regionCodes).not.toContain(row["region"]);
    }
    expect(t.columns.find((c) => c.key === "units")?.label).toBe("Units");
  });

  it("targets() labels region with display labels", () => {
    const t = targets(repo, { fy: 2026, q: 2 });
    expect(t.rows.length).toBeGreaterThan(0);
    for (const row of t.rows) expect(regionLabels).toContain(row["region"]);
  });

  it("kpi(yoy) yields missing (value=null) rather than 0% when there is no prior-year data (FY2025)", () => {
    const row = kpi(repo, { metric: "yoy", fy: 2025 }).rows[0]!;
    expect(row["value"]).toBeNull();
    expect(String(row["note"])).toContain("No baseline data");
  });

  it("kpi(yoy) returns a number when prior-year data exists (FY2026)", () => {
    const row = kpi(repo, { metric: "yoy", fy: 2026 }).rows[0]!;
    expect(typeof row["value"]).toBe("number");
  });

  it("kpi(target_attainment) yields missing when the target is unset (denominator 0)", () => {
    const row = kpi(repo, { metric: "target_attainment", fy: 2099 }).rows[0]!;
    expect(row["value"]).toBeNull();
    expect(String(row["note"])).toContain("No target set");
  });

  // Characterization tests (pre-refactor): kpi("top_region") had no coverage. Recompute the expected leading
  // region/share independently from the repo (not by calling summary()/sumByKey) so these pin today's behavior
  // rather than assuming the implementation under refactor.
  it("kpi(top_region) yields the leading region's revenue share when data exists (present branch)", () => {
    const current = repo.records.filter((r) => r.fiscalYear === 2026);
    const byRegion = new Map<string, number>();
    for (const r of current) byRegion.set(r.region, (byRegion.get(r.region) ?? 0) + r.revenue);
    const totalRevenue = current.reduce((s, r) => s + r.revenue, 0);
    const [topRegion, topRevenue] = [...byRegion.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const expectedShare = Math.round((topRevenue / totalRevenue) * 1000) / 10;

    const row = kpi(repo, { metric: "top_region", fy: 2026 }).rows[0]!;
    expect(row).toEqual({
      label: "Top region",
      value: expectedShare,
      format: "percent",
      note: `${REGION_LABELS[topRegion as keyof typeof REGION_LABELS]} (share)`,
    });
  });

  it("kpi(top_region) yields missing (value=null) when there is no data for the period (missing branch)", () => {
    const row = kpi(repo, { metric: "top_region", fy: 2099 }).rows[0]!;
    expect(row).toEqual({
      label: "Top region",
      value: null,
      format: "percent",
      note: "No revenue in period",
    });
  });

  it("kpi ignores dimension filters (region) and keeps company-wide scope", () => {
    const all = kpi(repo, { metric: "total_revenue", fy: 2026 }).rows[0]!;
    const withRegion = kpi(repo, { metric: "total_revenue", fy: 2026, region: "japan" }).rows[0]!;
    // Even when region is passed, aggregation stays company-wide (the contract that numerator/denominator scopes do not diverge).
    expect(withRegion["value"]).toBe(all["value"]);
  });
});

// summary() metric propagation (regression for a wrong-answer bugfix): the sort and topN slice branch on metric (revenue|units).
// Before the fix it was always revenue-descending + topN, so a "top 5 by units" request returned the top 5 by revenue.
describe("summary() metric (the basis for sort and topN)", () => {
  const repo = new SalesRepo();

  it("metric unspecified / metric=revenue is revenue descending (legacy behavior regression)", () => {
    const def = summary(repo, { fy: 2026, groupBy: "product" }).rows;
    const explicit = summary(repo, { fy: 2026, groupBy: "product", metric: "revenue" }).rows;
    expect(explicit).toEqual(def);
    const values = def.map((r) => r["revenue"] as number);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it("metric=units sorts by units descending", () => {
    const rows = summary(repo, { fy: 2026, groupBy: "product", metric: "units" }).rows;
    expect(rows.length).toBeGreaterThan(1);
    const values = rows.map((r) => r["units"] as number);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it("seed data has different rankings for units and revenue (FY2026: revenue leader Aurora CRM / units leader EdgeSight Sensor)", () => {
    const byRevenue = summary(repo, { fy: 2026, groupBy: "product" }).rows.map((r) => r["product"]);
    const byUnits = summary(repo, { fy: 2026, groupBy: "product", metric: "units" }).rows.map(
      (r) => r["product"],
    );
    // Rankings change due to unit-price differences (high unit price ranks high in revenue; low unit price sold in volume ranks high in units).
    expect(byRevenue[0]).toBe("Aurora CRM");
    expect(byUnits[0]).toBe("EdgeSight Sensor");
    expect(byUnits).not.toEqual(byRevenue);
  });

  it("topN slicing is also metric-based (top 1 by units is the product with max units)", () => {
    const topUnits = summary(repo, { fy: 2026, groupBy: "product", metric: "units", topN: "1" }).rows;
    expect(topUnits).toHaveLength(1);
    expect(topUnits[0]!["product"]).toBe("EdgeSight Sensor");
    // Before the fix, the slice was always revenue-descending regardless of metric, so the revenue leader (Aurora CRM) was returned.
    const topRevenue = summary(repo, { fy: 2026, groupBy: "product", topN: "1" }).rows;
    expect(topRevenue[0]!["product"]).toBe("Aurora CRM");
  });

  it("an unknown metric falls back to the default revenue (a NaN comparison does not break the sort)", () => {
    const def = summary(repo, { fy: 2026, groupBy: "product" }).rows;
    expect(summary(repo, { fy: 2026, groupBy: "product", metric: "bogus" }).rows).toEqual(def);
  });
});

// trend() metric normalization: symmetric with summary, an unknown value falls back to revenue. Without normalization, r[metric]
// is undefined -> aggregation becomes NaN. Same semantics as trend in Python's domain.py.
describe("trend() metric normalization", () => {
  const repo = new SalesRepo();

  it("metric unspecified / metric=revenue is the revenue series (both column key and cells are revenue)", () => {
    const def = trend(repo, { fy: 2026, granularity: "month" });
    const explicit = trend(repo, { fy: 2026, granularity: "month", metric: "revenue" });
    expect(explicit).toEqual(def);
    expect(def.columns.map((c) => c.key)).toContain("revenue");
    // Confirm the values are numeric (not NaN).
    for (const row of def.rows) expect(Number.isNaN(row["revenue"] as number)).toBe(false);
  });

  it("metric=units becomes the units series", () => {
    const t = trend(repo, { fy: 2026, granularity: "month", metric: "units" });
    expect(t.columns.map((c) => c.key)).toContain("units");
    for (const row of t.rows) expect(Number.isNaN(row["units"] as number)).toBe(false);
  });

  it("an unknown metric falls back to the default revenue (blocks NaN aggregation)", () => {
    const def = trend(repo, { fy: 2026, granularity: "month" });
    const bogus = trend(repo, { fy: 2026, granularity: "month", metric: "bogus" });
    // Since it falls back to revenue, it matches the default and the values are not NaN.
    expect(bogus).toEqual(def);
    for (const row of bogus.rows) expect(Number.isNaN(row["revenue"] as number)).toBe(false);
  });

  it("shapeOf('trend', ...) normalizes an unknown metric the same way trend() does, so the column sets match", () => {
    const args = { fy: 2026, granularity: "month", metric: "bogus" };
    const actual = trend(repo, args);
    const shape = shapeOf("trend", args);
    expect(shape).not.toBeNull();
    expect(shape!.columns.map((c) => c.name)).toEqual(actual.columns.map((c) => c.key));
  });
});

// targets() missing-value convention: to avoid an unset target (target<=0) being misread as "0% attainment",
// use attainment=null + note (same treatment as kpi's target_attainment; a null table cell renders as blank).
describe("targets() attainment missing value", () => {
  it("a row with target 0 sets attainment=null and shows the reason in note", () => {
    const repo = new SalesRepo();
    // The seed has no target of 0, so synthesize a target-0 row for an (fy, q) not present in the seed to exercise the missing-value path.
    repo.targets.push({ fiscalYear: 2027, quarter: 1, region: "japan", targetRevenue: 0 });
    const t = targets(repo, { fy: 2027, q: 1 });
    expect(t.rows).toHaveLength(1);
    const row = t.rows[0]!;
    expect(row["attainment"]).toBeNull();
    expect(String(row["note"])).toContain("No target set");
  });

  it("a normal row (target>0) keeps a numeric attainment with note=null (the note column always exists)", () => {
    const repo = new SalesRepo();
    const t = targets(repo, { fy: 2026, q: 2 });
    expect(t.columns.map((c) => c.key)).toEqual(["region", "actual", "target", "attainment", "note"]);
    expect(t.rows.length).toBeGreaterThan(0);
    for (const row of t.rows) {
      expect(typeof row["attainment"]).toBe("number");
      expect(row["note"]).toBeNull();
    }
  });

  it("a region with actual revenue but no target row for the period still appears (target=0, not dropped)", () => {
    const repo = new SalesRepo();
    // fy=2027 has no targets at all in the seed (which only covers FY2025/FY2026); push a single actual
    // record so the region has revenue but no matching target row, exercising the union-of-keys population.
    repo.records.push({
      id: "test-actual-no-target",
      fiscalYear: 2027,
      quarter: 1,
      month: "2027-04",
      region: "north_america",
      productId: "prd-001",
      channel: "direct",
      units: 10,
      revenue: 1_000_000,
    });
    const t = targets(repo, { fy: 2027, q: 1 });
    expect(t.rows).toHaveLength(1);
    const row = t.rows[0]!;
    expect(row["region"]).toBe("North America");
    expect(row["actual"]).toBe(1_000_000);
    expect(row["target"]).toBe(0);
    expect(row["attainment"]).toBeNull();
    expect(String(row["note"])).toContain("No target set");
  });
});

// summary() topN clamping (boundaries). Prevents slice from behaving counter-intuitively for negative / 0 / non-numeric values.
describe("summary() topN clamp", () => {
  const repo = new SalesRepo();

  it("a valid topN narrows to the top N (product has 6 groups -> topN=2 yields 2)", () => {
    const t = summary(repo, { fy: 2026, groupBy: "product", topN: "2" });
    expect(t.rows).toHaveLength(2);
  });

  it("topN of 0, negative, or non-number returns all groups without narrowing (prevents slice's counter-intuitive behavior)", () => {
    const full = summary(repo, { fy: 2026, groupBy: "product" }).rows.length;
    expect(full).toBeGreaterThan(1);
    expect(summary(repo, { fy: 2026, groupBy: "product", topN: "0" }).rows).toHaveLength(full);
    expect(summary(repo, { fy: 2026, groupBy: "product", topN: "-3" }).rows).toHaveLength(full);
    expect(summary(repo, { fy: 2026, groupBy: "product", topN: "abc" }).rows).toHaveLength(full);
  });
});
