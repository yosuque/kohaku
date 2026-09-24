import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coerceCell, parseCsv, readDataFile, sqliteSupported } from "../../src/init/readers.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "sales.csv");

describe("parseCsv", () => {
  it("handles quoted fields with commas, escaped quotes and CRLF", () => {
    const { header, records } = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n1,2\n');
    expect(header).toEqual(["a", "b"]);
    expect(records).toEqual([
      ["x, y", 'he said "hi"'],
      ["1", "2"],
    ]);
  });

  it("tolerates a trailing newline without producing a phantom empty row", () => {
    const { header, records } = parseCsv("a,b\n1,2\n3,4\n");
    expect(header).toEqual(["a", "b"]);
    expect(records).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles a header-only file (no data rows)", () => {
    const { header, records } = parseCsv("a,b\n");
    expect(header).toEqual(["a", "b"]);
    expect(records).toEqual([]);
  });

  it("reports each record's physical line number, unaffected by earlier blank lines", () => {
    const { records, lines } = parseCsv("a,b,c\n\n1,2\n");
    expect(records).toEqual([["1", "2"]]);
    expect(lines).toEqual([3]);
  });
});

describe("coerceCell", () => {
  it("coerces numbers, booleans and blanks; keeps everything else as text", () => {
    expect(coerceCell("12")).toBe(12);
    expect(coerceCell("-3.5")).toBe(-3.5);
    expect(coerceCell("true")).toBe(true);
    expect(coerceCell("")).toBeNull();
    expect(coerceCell("2026-04")).toBe("2026-04");
    expect(coerceCell("007")).toBe("007"); // leading zeros are identifiers, not numbers
  });

  it("keeps a long all-digit identifier as text instead of losing precision", () => {
    // 18 digits: well past Number.MAX_SAFE_INTEGER (16 digits), so Number(s) would round it.
    expect(coerceCell("123456789012345678")).toBe("123456789012345678");
  });

  it("still coerces an ordinary integer and an ordinary decimal to numbers", () => {
    expect(coerceCell("42")).toBe(42);
    expect(coerceCell("3.14")).toBe(3.14);
  });
});

describe("readDataFile", () => {
  it("reads a CSV into typed rows", async () => {
    const dataset = await readDataFile(FIXTURE);
    expect(dataset.columns).toEqual(["month", "region", "channel", "product", "units", "revenue"]);
    expect(dataset.rows).toHaveLength(6);
    expect(dataset.rows[3]).toEqual({
      month: "2026-05",
      region: "europe",
      channel: "direct",
      product: "Widget, C",
      units: 3,
      revenue: 45000,
    });
  });

  it("reads a JSON array of objects (or {rows: [...]})", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-init-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ x: 1, y: "a" }, { x: 2 }]));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ rows: [{ x: 1 }] }));
    expect((await readDataFile(join(dir, "a.json"))).rows).toEqual([
      { x: 1, y: "a" },
      { x: 2, y: null },
    ]);
    expect((await readDataFile(join(dir, "b.json"))).columns).toEqual(["x"]);
  });

  it.skipIf(!sqliteSupported())("reads the first user table of a SQLite file (or --table)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "kohaku-init-"));
    const db = new DatabaseSync(join(dir, "s.sqlite"));
    db.exec(
      "CREATE TABLE sales (month TEXT, revenue REAL); INSERT INTO sales VALUES ('2026-04', 10.5); CREATE TABLE other (id INTEGER);",
    );
    db.close();
    expect((await readDataFile(join(dir, "s.sqlite"))).rows).toEqual([{ month: "2026-04", revenue: 10.5 }]);
    expect((await readDataFile(join(dir, "s.sqlite"), { table: "other" })).columns).toEqual(["id"]);
  });

  it("rejects an unsupported extension and an empty file with a one-line error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-init-"));
    writeFileSync(join(dir, "x.xlsx"), "");
    writeFileSync(join(dir, "empty.csv"), "a,b\n");
    await expect(readDataFile(join(dir, "x.xlsx"))).rejects.toThrow(/Unsupported data file/);
    await expect(readDataFile(join(dir, "empty.csv"))).rejects.toThrow(/no rows/);
  });

  it("rejects a CSV row whose field count does not match the header, instead of silently padding it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-init-"));
    writeFileSync(join(dir, "ragged.csv"), "a,b,c\n1,2,3\n4,5\n");
    await expect(readDataFile(join(dir, "ragged.csv"))).rejects.toThrow(/row 3.*2 fields.*expected 3/);
  });

  it("reports the correct physical line number for a ragged row after a blank line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-init-"));
    writeFileSync(join(dir, "ragged2.csv"), "a,b,c\n\n1,2\n");
    await expect(readDataFile(join(dir, "ragged2.csv"))).rejects.toThrow(/row 3.*2 fields.*expected 3/);
  });

  it("strips a UTF-8 BOM from a CSV header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-init-"));
    writeFileSync(join(dir, "bom.csv"), "﻿month,revenue\n2026-04,100\n");
    const dataset = await readDataFile(join(dir, "bom.csv"));
    expect(dataset.columns).toEqual(["month", "revenue"]);
    expect(dataset.rows[0]).toEqual({ month: "2026-04", revenue: 100 });
  });

  it("strips a UTF-8 BOM from a JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-init-"));
    writeFileSync(join(dir, "bom.json"), `﻿${JSON.stringify([{ x: 1 }])}`);
    expect((await readDataFile(join(dir, "bom.json"))).columns).toEqual(["x"]);
  });
});

describe("sqliteSupported", () => {
  it("requires Node >= 22.13", () => {
    expect(sqliteSupported("22.12.0")).toBe(false);
    expect(sqliteSupported("22.13.0")).toBe(true);
    expect(sqliteSupported("24.1.0")).toBe(true);
  });
});
