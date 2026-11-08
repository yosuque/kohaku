import { type JsonObject, parseQueryRef } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { shapeOf } from "../src/domain/queries.js";
import { INTENT_DEFS } from "../src/intents/catalog.js";

// Regression for the shape-changing filters (Codex C9): an injected L1 filter swaps one bound query parameter, so
// the generated chart / table keeps the x / y / columns props of the initial variant. Every filter the sample
// catalog still derives must therefore leave the result's column names unchanged, for every option and every
// initial value -- metric (revenue -> units), granularity (month -> quarter) and groupBy (region -> product)
// are declared `filterable: false` precisely because they do not.

const columnNames = (path: string, params: Record<string, string>): string[] =>
  (shapeOf(path, params)?.columns ?? []).map((c) => c.name).sort();

describe("the sample catalog's L1 filters never change the result's column set", () => {
  const filtered = INTENT_DEFS.flatMap((def) => (def.filters?.() ?? []).map((filter) => ({ def, filter })));

  it("derives filters for the shape-stable facets only", () => {
    const params = filtered.map(({ def, filter }) => `${def.name}.${filter.param}`);
    expect(params).toContain("sales.trend.region");
    expect(params).toContain("sales.quarterly_summary.region");
    for (const shapeChanging of ["metric", "granularity", "groupBy"]) {
      expect(params.filter((p) => p.endsWith(`.${shapeChanging}`))).toEqual([]);
    }
  });

  for (const { def, filter } of filtered) {
    it(`${def.name}: switching ${filter.param} keeps the column names of every governed ref`, () => {
      const base = def.params.parse({}) as JsonObject;
      for (const handle of def.toQueries(base)) {
        const ref = parseQueryRef(handle.uri);
        if (!filter.paths.includes(ref.path)) continue;
        const expected = columnNames(ref.path, ref.params);
        expect(expected.length).toBeGreaterThan(0);
        for (const option of filter.options) {
          expect(columnNames(ref.path, { ...ref.params, [filter.queryParam]: option.value })).toEqual(
            expected,
          );
        }
      }
    });
  }
});
