import { readFileSync } from "node:fs";
import { extname } from "node:path";
import semver from "semver";

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

export interface Dataset {
  /** Header order of the source (raw names; the caller slugifies them). */
  columns: string[];
  rows: Row[];
}

/**
 * RFC 4180-style CSV: quoted fields may contain commas, newlines and doubled quotes. Trailing
 * newline tolerated. `lines[i]` is the 1-indexed physical line on which `records[i]` starts
 * (the header itself is line 1), so a caller reporting a per-row error can point at the exact
 * line even when earlier blank lines or multi-line quoted fields have shifted the record index
 * away from the line number.
 */
export function parseCsv(text: string): { header: string[]; records: string[][]; lines: number[] } {
  const records: string[][] = [];
  const lineNumbers: number[] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let sawAnyField = false;
  let lineNo = 1;
  let recordStartLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
        // An embedded newline inside a quoted field still advances the physical line count.
        if (ch === "\n") lineNo++;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      sawAnyField = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      sawAnyField = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (sawAnyField || field !== "" || record.length > 0) {
        record.push(field);
        records.push(record);
        lineNumbers.push(recordStartLine);
      }
      field = "";
      record = [];
      sawAnyField = false;
      lineNo++;
      recordStartLine = lineNo;
    } else {
      field += ch;
      sawAnyField = true;
    }
  }
  if (sawAnyField || field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
    lineNumbers.push(recordStartLine);
  }
  const [header, ...rest] = records;
  const [, ...restLines] = lineNumbers;
  if (header == null) throw new Error("The CSV file is empty (expected a header row)");
  return { header: header.map((h) => h.trim()), records: rest, lines: restLines };
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function coerceCell(raw: string): Cell {
  const s = raw.trim();
  if (s === "") return null;
  if (NUMBER.test(s)) {
    const n = Number(s);
    // An all-digit value with no fractional part (a long order/invoice id, a barcode, ...) is an
    // identifier, not a measure: if it cannot round-trip through a JS number, keep the original
    // text instead of silently corrupting it. A value with a fractional part is treated as a
    // measure, where sub-ulp error is immaterial, so it keeps coercing unconditionally.
    if (!s.includes(".") && !Number.isSafeInteger(n)) return s;
    return n;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

/** node:sqlite is unflagged from Node 22.13 (and 23.4); older 22.x needs --experimental-sqlite, which npx cannot pass. */
export function sqliteSupported(nodeVersion: string = process.versions.node): boolean {
  return semver.gte(nodeVersion, "22.13.0");
}

/** Shared JSON/SQLite value coercion: strings still go through coerceCell, other primitives pass through as-is. */
function cellFromValue(v: unknown): Cell {
  return v == null
    ? null
    : typeof v === "string"
      ? coerceCell(v)
      : typeof v === "number" || typeof v === "boolean"
        ? v
        : String(v);
}

/** A leading UTF-8 BOM (e.g. from Excel's "CSV UTF-8" export) would otherwise corrupt the first header/key name. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function fromObjects(objects: unknown[], what: string): Dataset {
  const columns: string[] = [];
  for (const obj of objects) {
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error(`${what}: every row must be a JSON object`);
    }
    for (const key of Object.keys(obj)) if (!columns.includes(key)) columns.push(key);
  }
  const rows: Row[] = objects.map((obj) => {
    const row: Row = {};
    for (const col of columns) row[col] = cellFromValue((obj as Record<string, unknown>)[col]);
    return row;
  });
  return { columns, rows };
}

async function readSqlite(path: string, table?: string): Promise<Dataset> {
  if (!sqliteSupported()) {
    throw new Error(
      `Reading ${path} needs Node >= 22.13 (node:sqlite); you are on ${process.versions.node}. Export the table to CSV or upgrade Node.`,
    );
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all()
      .map((r) => String((r as { name: unknown }).name));
    const chosen = table ?? tables[0];
    if (chosen == null) throw new Error(`${path} has no tables`);
    if (!tables.includes(chosen))
      throw new Error(`${path} has no table "${chosen}" (available: ${tables.join(", ")})`);
    const stmt = db.prepare(`SELECT * FROM "${chosen.replace(/"/g, '""')}"`);
    // Column names come from the compiled statement, not from the fetched rows, so a table with
    // zero rows still reports its real columns (see the "other" table case in readers.test.ts).
    const columns = stmt.columns().map((c) => c.name);
    const objects = stmt.all() as Record<string, unknown>[];
    const rows: Row[] = objects.map((obj) => {
      const row: Row = {};
      for (const col of columns) row[col] = cellFromValue(obj[col]);
      return row;
    });
    return { columns, rows };
  } finally {
    db.close();
  }
}

function fromCsv(path: string, text: string): Dataset {
  const { header, records, lines } = parseCsv(text);
  const rows = records.map((rec, i) => {
    if (rec.length !== header.length) {
      // Reject rather than silently pad: a misaligned row (dropped/shifted column) would corrupt
      // every project generated downstream, and that failure would be far harder to notice there
      // than a clear error here, at the moment the data is first read.
      throw new Error(
        `${path}: row ${lines[i]} has ${rec.length} fields, expected ${header.length} (header: ${header.join(", ")})`,
      );
    }
    return Object.fromEntries(header.map((h, col) => [h, coerceCell(rec[col]!)])) as Row;
  });
  return { columns: header, rows };
}

export async function readDataFile(path: string, options: { table?: string } = {}): Promise<Dataset> {
  const ext = extname(path).toLowerCase();
  if (ext === ".csv") {
    const dataset = fromCsv(path, stripBom(readFileSync(path, "utf8")));
    if (dataset.rows.length === 0) throw new Error(`${path} has no rows`);
    return dataset;
  }
  if (ext === ".json") {
    // A BOM would otherwise turn into a JSON.parse SyntaxError at position 0 with no useful
    // explanation, so strip it here too even though a BOM-prefixed JSON export is less common
    // than a BOM-prefixed "CSV UTF-8" export.
    const parsed: unknown = JSON.parse(stripBom(readFileSync(path, "utf8")));
    const objects = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(objects))
      throw new Error(`${path}: expected a JSON array of objects or {"rows": [...]}`);
    const dataset = fromObjects(objects, path);
    if (dataset.rows.length === 0) throw new Error(`${path} has no rows`);
    return dataset;
  }
  if (ext === ".sqlite" || ext === ".db" || ext === ".sqlite3") {
    // Unlike CSV/JSON, a SQLite table's columns are known from its schema even with zero matching
    // rows, so an empty-but-existing table is a valid (if minimal) dataset, not an error.
    return readSqlite(path, options.table);
  }
  throw new Error(`Unsupported data file "${path}" (expected .csv, .json, .sqlite / .db / .sqlite3)`);
}
