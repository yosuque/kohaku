import { describe, expect, it } from "vitest";
import {
  humanize,
  inferProfile,
  MAX_VOCABULARY_VALUES,
  normalizeRows,
  slugify,
} from "../../src/init/infer.js";
import type { Dataset } from "../../src/init/readers.js";

function dataset(rows: Record<string, unknown>[]): Dataset {
  const columns = Object.keys(rows[0]!);
  return { columns, rows: rows as Dataset["rows"] };
}

describe("slugify / humanize", () => {
  it("slugify makes a safe snake_case identifier", () => {
    expect(slugify("Sales Region")).toBe("sales_region");
    expect(slugify("Revenue (JPY)")).toBe("revenue_jpy");
    expect(slugify("2024 total")).toBe("c_2024_total");
    // Non-ASCII falls back to a hex slug prefixed with c_. This literal is the sha256("売上")
    // hex digest's first 12 characters, computed independently — not adjusted to match whatever
    // the implementation happens to produce.
    expect(slugify("売上")).toBe("c_443fb9483be0");
  });
  it("humanize turns codes into labels", () => {
    expect(humanize("north_america")).toBe("North america");
    expect(humanize("Widget A")).toBe("Widget A");
  });
});

describe("inferProfile", () => {
  const sales = dataset([
    {
      month: "2026-04",
      region: "japan",
      "Sales Channel": "direct",
      order_id: 1,
      units: 12,
      revenue: 120000,
      note: "first",
    },
    {
      month: "2026-05",
      region: "europe",
      "Sales Channel": "online",
      order_id: 2,
      units: 3,
      revenue: 45000,
      note: "second",
    },
    {
      month: "2026-06",
      region: "japan",
      "Sales Channel": "direct",
      order_id: 3,
      units: 9,
      revenue: 126000,
      note: null,
    },
  ]);

  it("classifies time, dimensions, measures, ids and free text", () => {
    const profile = inferProfile("sales", sales);
    expect(profile.time?.name).toBe("month");
    expect(profile.dimensions.map((c) => c.name)).toEqual(["region", "sales_channel"]);
    expect(profile.dimensions[0]!.values).toEqual(["japan", "europe"]);
    expect(profile.measures.map((c) => c.name)).toEqual(["units", "revenue"]);
    expect(profile.columns.find((c) => c.name === "order_id")?.kind).toBe("id");
    expect(profile.columns.find((c) => c.name === "note")?.kind).toBe("text");
    expect(profile.rowCount).toBe(3);
  });

  it("treats booleans as a two-valued dimension and slash dates as time", () => {
    const profile = inferProfile(
      "x",
      dataset([
        { d: "2026/04/01", flag: true, v: 1 },
        { d: "2026/04/02", flag: false, v: 2 },
      ]),
    );
    expect(profile.time?.name).toBe("d");
    expect(profile.dimensions[0]).toMatchObject({ name: "flag", type: "boolean", values: ["true", "false"] });
  });

  it("caps vocabularies at 24 distinct values (a wider column is free text)", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ city: `city${i % 25}`, v: i }));
    // A real dimension ("cat") is included alongside the too-wide "city" column so this dataset
    // has a valid category to build the vocabulary from — otherwise, with only "city" (25
    // distinct, over the cap, so demoted to text) and the numeric "v" measure, the dataset would
    // have zero dimension columns and inferProfile would throw before the assertion below runs.
    const withCat = rows.map((r) => ({ ...r, cat: r.v % 2 === 0 ? "a" : "b" }));
    const profile = inferProfile("x", dataset(withCat));
    expect(profile.columns.find((c) => c.name === "city")?.kind).toBe("text");
    // Without "cat", the same 30 rows have no eligible dimension at all (city is over the cap,
    // v is a measure) -> inferProfile correctly refuses to generate a project from them.
    expect(() => inferProfile("x", dataset(rows))).toThrow(/No categorical column/);
  });

  it("keeps exactly 24 distinct values as a dimension (boundary)", () => {
    // 24 distinct cities, repeated so distinct < row count -> dimension.
    const rows = Array.from({ length: 48 }, (_, i) => ({ city: `city${i % 24}`, v: i }));
    const profile = inferProfile("x", dataset(rows));
    const city = profile.columns.find((c) => c.name === "city");
    expect(city?.kind).toBe("dimension");
    expect(city?.values).toHaveLength(24);
  });

  it("treats 25 distinct values as text, not a dimension (boundary)", () => {
    // 25 distinct cities, repeated so distinct < row count (not an id either) -> text.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      city: `city${i % 25}`,
      v: i,
      cat: i % 2 === 0 ? "a" : "b",
    }));
    const profile = inferProfile("x", dataset(rows));
    expect(profile.columns.find((c) => c.name === "city")?.kind).toBe("text");
  });

  it("only the first date-like column becomes time; later ones become text", () => {
    const profile = inferProfile(
      "x",
      dataset([
        { first: "2026-01-01", second: "2026-02-01", cat: "a", v: 1 },
        { first: "2026-01-02", second: "2026-02-02", cat: "b", v: 2 },
        { first: "2026-01-03", second: "2026-02-03", cat: "a", v: 3 },
      ]),
    );
    expect(profile.time?.name).toBe("first");
    const second = profile.columns.find((c) => c.name === "second");
    // Every value of `second` is distinct (one per row), which would otherwise read as an "id" —
    // the "only the first date column is time" rule must win over the generic string rules.
    expect(second?.kind).toBe("text");
    expect(second?.type).toBe("string");
  });

  it("treats an entirely-null column as text", () => {
    const profile = inferProfile(
      "x",
      dataset([
        { cat: "a", empty: null, v: 1 },
        { cat: "b", empty: null, v: 2 },
        { cat: "a", empty: null, v: 3 },
      ]),
    );
    const empty = profile.columns.find((c) => c.name === "empty");
    expect(empty?.kind).toBe("text");
    expect(empty?.type).toBe("string");
    expect(empty?.values).toBeUndefined();
    // Sanity check: "cat" (distinct < row count) is still correctly inferred as a dimension, so
    // the all-null "empty" column isn't merely benefiting from the "no dimension -> throw" path.
    expect(profile.columns.find((c) => c.name === "cat")?.kind).toBe("dimension");
  });

  it("throws when every column is entirely null (no dimension possible)", () => {
    const rows = [
      { a: null, b: null },
      { a: null, b: null },
    ];
    expect(() => inferProfile("x", dataset(rows))).toThrow(/No categorical column/);
  });

  it("collects a dimension value that first appears only after SAMPLE_ROWS via a full-column scan", () => {
    // First 5000 rows only ever use "japan"/"europe" for `region`, so classification (which only
    // looks at the sample) sees a 2-value dimension. Rows after index 5000 introduce a third
    // value, "asia", for the first time. A full scan over every row must still pick it up: it is
    // a real value in the dataset, and `values` becomes a closed vocabulary downstream.
    const rows = Array.from({ length: 5500 }, (_, i) => {
      const region =
        i < 5000
          ? i % 2 === 0
            ? "japan"
            : "europe"
          : i % 3 === 0
            ? "asia"
            : i % 3 === 1
              ? "japan"
              : "europe";
      return { region, v: i };
    });
    const profile = inferProfile("x", dataset(rows));
    const region = profile.columns.find((c) => c.name === "region");
    expect(region?.kind).toBe("dimension");
    expect(region?.values).toEqual(["japan", "europe", "asia"]);
  });

  it("demotes a dimension to text when the full scan finds more than MAX_VOCABULARY_VALUES distinct values", () => {
    // The first 5000 rows only ever use 10 distinct `cat` values, so classification (sample-only)
    // sees a well-behaved 10-value dimension. Rows after index 5000 each introduce a brand-new,
    // never-repeated value — the full scan must catch that the true vocabulary is unbounded and
    // demote the column to text, consistent with what the cap already means for the sampled path.
    const rows = Array.from({ length: 5500 }, (_, i) => {
      const cat = i < 5000 ? `cat${i % 10}` : `extra${i}`;
      const region = i % 2 === 0 ? "japan" : "europe";
      return { cat, region, v: i };
    });
    const profile = inferProfile("x", dataset(rows));
    const cat = profile.columns.find((c) => c.name === "cat");
    expect(cat?.kind).toBe("text");
    expect(cat?.values).toBeUndefined();
    // A genuinely small dimension elsewhere in the dataset means inferProfile does not throw even
    // though "cat" is demoted after initially looking like a dimension in the sample.
    expect(profile.columns.find((c) => c.name === "region")?.kind).toBe("dimension");
  });

  it("disambiguates headers that collide after slugifying, keeping both columns", () => {
    const ds: Dataset = {
      columns: ["Sales Region", "sales region", "a-b", "a_b"],
      rows: [
        { "Sales Region": "japan", "sales region": "europe", "a-b": 1, a_b: 2 },
        { "Sales Region": "japan", "sales region": "asia", "a-b": 3, a_b: 4 },
        { "Sales Region": "emea", "sales region": "europe", "a-b": 5, a_b: 6 },
      ],
    };
    const profile = inferProfile("x", ds);
    const names = profile.columns.map((c) => c.name);
    // No column is silently dropped or overwritten, and names stay stable / predictable
    // (first occurrence keeps the plain slug, later collisions get a numeric suffix).
    expect(names).toEqual(["sales_region", "sales_region_2", "a_b", "a_b_2"]);
    expect(new Set(names).size).toBe(4);
  });

  it("does not let a generated collision suffix steal another column's own natural name", () => {
    // Header list has a genuine duplicate ("a" twice) plus a third, unrelated header that happens
    // to literally be "a_2" — the exact shape the numbered scheme would otherwise generate for
    // the second "a". (Two columns can't literally both be named "a" in a JS row object, so both
    // read the same underlying "a" cell here — irrelevant to this test, which only checks naming.)
    // The second "a" must skip past "a_2" (reserved for the third column's own natural slug) and
    // land on "a_3"; the third column keeps the plain name it would have had on its own.
    const ds: Dataset = {
      columns: ["a", "a", "a_2"],
      rows: [
        { a: "x", a_2: "p" },
        { a: "x", a_2: "q" },
        { a: "y", a_2: "r" },
      ],
    };
    const profile = inferProfile("x", ds);
    const names = profile.columns.map((c) => c.name);
    expect(names).toEqual(["a", "a_3", "a_2"]);
    expect(new Set(names).size).toBe(3);
  });

  it("assigns column_<i> for a blank header, distinct from the non-ASCII hash fallback", () => {
    const ds: Dataset = {
      columns: ["", "cat"],
      rows: [
        { "": 1, cat: "a" },
        { "": 2, cat: "a" },
      ],
    };
    const profile = inferProfile("x", ds);
    expect(profile.columns[0]!.name).toBe("column_0");
    expect(profile.columns[0]!.sourceName).toBe("");
  });
});

describe("normalizeRows", () => {
  it("renames keys to slugs and normalizes slash dates", () => {
    const ds = dataset([
      { "Sales Region": "japan", When: "2026/04/01", v: 1 },
      { "Sales Region": "japan", When: "2026/05/01", v: 2 },
    ]);
    const profile = inferProfile("x", ds);
    expect(normalizeRows(ds, profile)).toEqual([
      { sales_region: "japan", when: "2026-04-01", v: 1 },
      { sales_region: "japan", when: "2026-05-01", v: 2 },
    ]);
  });

  it("fills a missing key with null", () => {
    const ds: Dataset = {
      columns: ["cat", "v"],
      rows: [{ cat: "a", v: 1 }, { cat: "a" }, { cat: "b", v: 3 }],
    };
    const profile = inferProfile("x", ds);
    expect(normalizeRows(ds, profile)).toEqual([
      { cat: "a", v: 1 },
      { cat: "a", v: null },
      { cat: "b", v: 3 },
    ]);
  });
});

it("re-exports MAX_VOCABULARY_VALUES as 24", () => {
  expect(MAX_VOCABULARY_VALUES).toBe(24);
});
