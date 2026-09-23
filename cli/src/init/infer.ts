import { createHash } from "node:crypto";
import type { Cell, Dataset, Row } from "./readers.js";

export type ColumnKind = "dimension" | "measure" | "time" | "id" | "text";

export interface ColumnProfile {
  /** Slug (snake_case) used as the generated identifier / object key. */
  name: string;
  /** Raw header from the source file. */
  sourceName: string;
  type: "string" | "number" | "boolean" | "date";
  kind: ColumnKind;
  /** Distinct values in first-appearance order (dimension only, <= MAX_VOCABULARY_VALUES). */
  values?: string[];
}

export interface DatasetProfile {
  /** Slug of --source / the file basename. */
  source: string;
  columns: ColumnProfile[];
  dimensions: ColumnProfile[];
  measures: ColumnProfile[];
  time: ColumnProfile | null;
  rowCount: number;
  /**
   * Present only when `time` is null. Names the string column(s) whose sampled values are
   * overwhelmingly date-like in a shape `inferProfile` deliberately does not guess at (see
   * AMBIGUOUS_DATE below) — most commonly a US `MM/DD/YYYY` or European `DD/MM/YYYY` column. Those
   * two shapes are indistinguishable from each other for any day-of-month <= 12, so guessing
   * between them would silently mis-date a large fraction of rows, which is worse than producing no
   * chart at all. This field exists so the CLI can tell the user *why* there is no time column
   * (format, not absence) and what to do about it, instead of just reporting "(none)".
   */
  unrecognizedDateColumns?: string[];
}

export const MAX_VOCABULARY_VALUES = 24;
const SAMPLE_ROWS = 5000;
// Year-first, unambiguous: YYYY-M[-D] / YYYY/M[/D], zero-padded or not ("2026-04-01", "2026-4-1").
// The year always comes first and is always 4 digits, so widening month/day to 1-2 digits here
// introduces no new ambiguity (unlike a day-first or month-first shape, see AMBIGUOUS_DATE).
const DATE = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/;
// Day/month-first with a 4-digit year, e.g. "04/01/2026" (US MM/DD/YYYY) or "01/04/2026" (European
// DD/MM/YYYY). Deliberately NOT treated as a recognized date shape (see DATE above and
// `inferProfile`'s unrecognizedDateColumns) — only used to warn the user, never to guess.
const AMBIGUOUS_DATE = /^\d{1,2}[-/]\d{1,2}[-/]\d{4}/;

/**
 * Turns an arbitrary column header into a safe snake_case identifier.
 * "Sales Region" -> "sales_region"; a slug starting with a digit gets a "c_" prefix
 * (JS identifiers / generated Zod keys can't start with a digit); a name with no ASCII
 * alphanumerics at all (e.g. non-Latin scripts) falls back to a "c_" + sha256 hex slug so the
 * result is still stable across runs. An actually-empty header ("") also hashes to a fixed,
 * non-descriptive slug here — callers that want a friendlier "column_<i>" for a blank header
 * (there's no name to hash meaningfully) apply that before calling slugify; see inferProfile.
 */
export function slugify(name: string): string {
  const ascii = name
    .trim()
    // Split "SalesRegion"-style camelCase before lowercasing, so it becomes "sales_region"
    // instead of "salesregion".
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (ascii === "") return `c_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
  return /^[0-9]/.test(ascii) ? `c_${ascii}` : ascii;
}

/** Turns a stored code/slug into a human-readable label: "north_america" -> "North america". */
export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Makes `base` unique against `used` by appending a numeric suffix ("_2", "_3", ...) on
 * collision, rather than dropping or silently overwriting a column. The first column to reach a
 * given slug keeps the plain name; every later header that collides with it (e.g. "Sales Region"
 * and "sales region" both slugify to "sales_region") gets the next free numbered variant. This
 * keeps names deterministic (source column order decides who gets the plain name) and readable
 * in generated code, unlike an underscore-accumulating scheme ("sales_region_", "sales_region__").
 *
 * `naturalSlugs` is every column's own natural slug (computed up front, in `inferProfile`'s first
 * pass), not just the names assigned so far. A generated candidate suffix is skipped when it
 * matches another column's natural slug, so a numbered suffix can never steal the plain name a
 * later, unrelated column would otherwise have earned on its own merits (e.g. a real header
 * "Region 2" naturally slugifies to "region_2" — exactly the shape this scheme generates for a
 * collision — so "region_2" must stay reserved for that column even while disambiguating a
 * different "region" collision).
 */
function uniqueName(base: string, used: Set<string>, naturalSlugs: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`) || naturalSlugs.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function classify(sourceName: string, name: string, cells: Cell[], timeTaken: boolean): ColumnProfile {
  const present = cells.filter((c): c is Exclude<Cell, null> => c != null);

  if (present.length > 0 && present.every((c) => typeof c === "number")) {
    const unique = new Set(present).size === present.length;
    return { name, sourceName, type: "number", kind: /(^|_)id$/i.test(name) && unique ? "id" : "measure" };
  }

  const strings = present.map((c) => String(c));
  const dateLike = strings.filter((s) => DATE.test(s)).length;
  const looksLikeDate = strings.length > 0 && dateLike / strings.length >= 0.95;
  if (looksLikeDate) {
    if (!timeTaken) {
      return { name, sourceName, type: "date", kind: "time" };
    }
    // Only the first date-like column becomes the time axis. A second date column (e.g. an
    // "updated_at" alongside "created_at") is demoted straight to free text: its values are very
    // likely all-distinct, which would otherwise misclassify it as an "id" under the generic
    // string rule below, and it is not a measure or a dimension either.
    return { name, sourceName, type: "string", kind: "text" };
  }

  if (present.length > 0 && present.every((c) => typeof c === "boolean")) {
    return { name, sourceName, type: "boolean", kind: "dimension", values: ["true", "false"] };
  }

  const distinct: string[] = [];
  for (const s of strings) if (!distinct.includes(s)) distinct.push(s);
  if (distinct.length > 0 && distinct.length <= MAX_VOCABULARY_VALUES && distinct.length < strings.length) {
    return { name, sourceName, type: "string", kind: "dimension", values: distinct };
  }
  // "id" is checked against the total row count (cells.length), not the non-null count
  // (strings.length): a real identifier column has exactly one distinct value per row and no
  // gaps, so a column with any null rows (e.g. "note", present for 2 of 3 rows, both distinct)
  // never qualifies as an id — it falls through to free text instead.
  if (distinct.length > 0 && distinct.length === cells.length) {
    return { name, sourceName, type: "string", kind: "id" };
  }
  // Catch-all: free text, an entirely-null column (present.length === 0), a vocabulary wider than
  // MAX_VOCABULARY_VALUES, or a partially-null column whose non-null values happen to be distinct.
  return { name, sourceName, type: "string", kind: "text" };
}

/**
 * Scans every row (not just the classification sample) to build a dimension column's true value
 * vocabulary, stopping as soon as the distinct count exceeds MAX_VOCABULARY_VALUES so this never
 * builds a huge set for a column that turns out not to be a real dimension. Returns null when the
 * cap is exceeded (the caller demotes the column to text), otherwise the distinct values in
 * first-appearance order across the full dataset.
 *
 * This exists because classification's 95%/cap heuristics only look at the first SAMPLE_ROWS rows
 * (a sample is exactly right for deciding "is this numeric / date-like / boolean" — that's a
 * statistical judgment about the column's shape). But `values` becomes a *closed* vocabulary
 * downstream (a Zod enum, an Intent catalog, a fixed L0 Spec), so it must reflect every row: a
 * value that only first appears after row SAMPLE_ROWS is still a real value a generated project
 * must accept, not something the sample gets to silently omit.
 */
function collectFullVocabulary(sourceName: string, rows: Row[]): string[] | null {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of rows) {
    const c = row[sourceName] ?? null;
    if (c == null) continue;
    const s = String(c);
    if (seen.has(s)) continue;
    seen.add(s);
    values.push(s);
    if (values.length > MAX_VOCABULARY_VALUES) return null;
  }
  return values;
}

/**
 * Turns a raw Dataset into a DatasetProfile: which columns are dimensions (with their value
 * vocabularies), which are measures, and which one (if any) is the time axis. Type detection
 * (numeric / date-like / boolean / cardinality shape) is decided from the first SAMPLE_ROWS rows
 * only — a sample is exactly right for that statistical judgment. A confirmed dimension's actual
 * value vocabulary, however, is collected with a full scan over every row (see
 * collectFullVocabulary): `values` becomes a closed vocabulary downstream, so it must include a
 * value that only first appears after SAMPLE_ROWS, and a column that looks small in the sample
 * but is unbounded overall is demoted to text rather than shipped as a fake-closed vocabulary.
 * Null cells are excluded from every ratio/uniqueness check. Throws when no dimension column is
 * found — a project can't be generated without at least one categorical column to build the
 * Intent vocabulary from (demoting an over-cap dimension to text can itself trigger this, which is
 * the correct outcome: a column that isn't a real dimension shouldn't count as one).
 */
export function inferProfile(source: string, dataset: Dataset): DatasetProfile {
  const sample = dataset.rows.slice(0, SAMPLE_ROWS);
  // First pass: every column's natural slug, computed up front so the second pass can tell a
  // "generated disambiguation suffix" apart from "another column's own honest name" (see
  // uniqueName). A blank header has nothing meaningful to slugify, so it gets a plain positional
  // name instead of being routed through slugify's non-ASCII hash fallback (which would produce an
  // equally opaque but needlessly hash-looking name for what is really just "no header").
  const naturalSlugs = dataset.columns.map((sourceName, i) =>
    sourceName.trim() === "" ? `column_${i}` : slugify(sourceName),
  );
  const naturalSlugSet = new Set(naturalSlugs);

  const used = new Set<string>();
  const columns: ColumnProfile[] = [];
  let timeTaken = false;

  // Second pass: assign the actual (possibly disambiguated) name and classify each column.
  for (let i = 0; i < dataset.columns.length; i++) {
    const sourceName = dataset.columns[i]!;
    const base = naturalSlugs[i]!;
    const name = uniqueName(base, used, naturalSlugSet);
    used.add(name);

    const cells = sample.map((row) => row[sourceName] ?? null);
    let profile = classify(sourceName, name, cells, timeTaken);
    if (profile.kind === "dimension" && profile.type === "string") {
      // Booleans are excluded (type !== "string"): their vocabulary is always the fixed
      // ["true", "false"] regardless of row count, so there is nothing to rescan.
      const vocabulary = collectFullVocabulary(sourceName, dataset.rows);
      profile =
        vocabulary === null
          ? { name, sourceName, type: "string", kind: "text" }
          : { ...profile, values: vocabulary };
    }
    if (profile.kind === "time") timeTaken = true;
    columns.push(profile);
  }

  const dimensions = columns.filter((c) => c.kind === "dimension");
  if (dimensions.length === 0) {
    throw new Error(
      "No categorical column found (a text column with at most 24 distinct values, or a boolean). " +
        "kohaku init needs at least one to build the Intent vocabulary; add a category column or lower the cardinality.",
    );
  }

  const time = columns.find((c) => c.kind === "time") ?? null;
  // Only worth looking for an unrecognized date shape when there's no time column at all: if one
  // was found, the user already has a Trend view, and a second, unrelated column that merely looks
  // date-like (e.g. a second real date column, demoted to text above) isn't worth warning about.
  const unrecognizedDateColumns = time == null ? findUnrecognizedDateColumns(columns, sample) : undefined;

  return {
    source: slugify(source),
    columns,
    dimensions,
    measures: columns.filter((c) => c.kind === "measure"),
    time,
    rowCount: dataset.rows.length,
    ...(unrecognizedDateColumns != null && unrecognizedDateColumns.length > 0
      ? { unrecognizedDateColumns }
      : {}),
  };
}

/**
 * Scans every already-classified string column's sampled cells for the ambiguous day/month-first
 * date shape (see AMBIGUOUS_DATE) using the same 95%-of-non-null-values threshold as `classify`'s
 * own date detection. Only called when no time column was found (see `inferProfile`). Returns the
 * matching column names in column order, or an empty array when none qualify.
 */
function findUnrecognizedDateColumns(columns: ColumnProfile[], sample: Row[]): string[] {
  const found: string[] = [];
  for (const col of columns) {
    if (col.type !== "string") continue;
    const strings = sample
      .map((row) => row[col.sourceName] ?? null)
      .filter((c): c is string => typeof c === "string");
    if (strings.length === 0) continue;
    const hits = strings.filter((s) => AMBIGUOUS_DATE.test(s)).length;
    if (hits / strings.length >= 0.95) found.push(col.name);
  }
  return found;
}

// Matches the (already slash-normalized) prefix of a date value so it can be re-padded to a fixed
// width: group 1 = year, group 2 = month, group 3 = optional day. Anything after the matched
// prefix (e.g. a time-of-day suffix on a full timestamp) is preserved verbatim, unpadded.
const DATE_PARTS = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/;

/**
 * Normalizes a date cell to a consistent, zero-padded shape: "2026/4/1" and "2026-4-1" both become
 * "2026-04-01"; "2026-4" becomes "2026-04". This matters because the same value is written into
 * three places that must agree byte-for-byte: the generated project's data file, its fixed Spec /
 * query parameters, and its golden fixture — without padding, "2026-4-1" and "2026-04-01" would be
 * different strings to all three even though they mean the same day.
 */
function normalizeDateValue(v: string): string {
  const slashed = v.replace(/\//g, "-");
  const m = DATE_PARTS.exec(slashed);
  if (!m) return slashed;
  const [whole, year, month, day] = m;
  const pad = (s: string) => s.padStart(2, "0");
  const normalized = day != null ? `${year}-${pad(month!)}-${pad(day)}` : `${year}-${pad(month!)}`;
  return normalized + slashed.slice(whole!.length);
}

/** Rewrites rows to slug keys; date cells become zero-padded ISO-ish strings ("2026/4/1" -> "2026-04-01"). */
export function normalizeRows(dataset: Dataset, profile: DatasetProfile): Row[] {
  return dataset.rows.map((row) => {
    const out: Row = {};
    for (const col of profile.columns) {
      const v = row[col.sourceName] ?? null;
      out[col.name] = col.type === "date" && typeof v === "string" ? normalizeDateValue(v) : v;
    }
    return out;
  });
}
