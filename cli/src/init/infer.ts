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
}

export const MAX_VOCABULARY_VALUES = 24;
const SAMPLE_ROWS = 5000;
const DATE = /^\d{4}[-/]\d{2}([-/]\d{2})?/;

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
 */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
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
 * Turns a raw Dataset into a DatasetProfile: which columns are dimensions (with their value
 * vocabularies), which are measures, and which one (if any) is the time axis. Only the first
 * SAMPLE_ROWS rows are inspected; null cells are excluded from every ratio/uniqueness check.
 * Throws when no dimension column is found — a project can't be generated without at least one
 * categorical column to build the Intent vocabulary from.
 */
export function inferProfile(source: string, dataset: Dataset): DatasetProfile {
  const sample = dataset.rows.slice(0, SAMPLE_ROWS);
  const used = new Set<string>();
  const columns: ColumnProfile[] = [];
  let timeTaken = false;

  for (let i = 0; i < dataset.columns.length; i++) {
    const sourceName = dataset.columns[i]!;
    // A blank header has nothing meaningful to slugify, so it gets a plain positional name
    // instead of being routed through slugify's non-ASCII hash fallback (which would produce an
    // equally opaque but needlessly hash-looking name for what is really just "no header").
    const base = sourceName.trim() === "" ? `column_${i}` : slugify(sourceName);
    const name = uniqueName(base, used);
    used.add(name);

    const cells = sample.map((row) => row[sourceName] ?? null);
    const profile = classify(sourceName, name, cells, timeTaken);
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

  return {
    source: slugify(source),
    columns,
    dimensions,
    measures: columns.filter((c) => c.kind === "measure"),
    time: columns.find((c) => c.kind === "time") ?? null,
    rowCount: dataset.rows.length,
  };
}

/** Rewrites rows to slug keys; date cells become ISO-ish strings ("2026/04/01" -> "2026-04-01"). */
export function normalizeRows(dataset: Dataset, profile: DatasetProfile): Row[] {
  return dataset.rows.map((row) => {
    const out: Row = {};
    for (const col of profile.columns) {
      const v = row[col.sourceName] ?? null;
      out[col.name] = col.type === "date" && typeof v === "string" ? v.replace(/\//g, "-") : v;
    }
    return out;
  });
}
