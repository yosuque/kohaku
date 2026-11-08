import { describe, expect, it } from "vitest";
import { readCatalog } from "../../../scripts/lib/read-catalog.mjs";

describe("readCatalog", () => {
  it("reads plain, double-quoted and single-quoted keys", () => {
    const catalog = readCatalog(
      ["catalog:", "  hono: ^4.13.8", '  "@hono/node-server": ^2.1.6', "  'tsx': 4.0.0", ""].join("\n"),
    );
    expect([...catalog]).toEqual([
      ["hono", "^4.13.8"],
      ["@hono/node-server", "^2.1.6"],
      ["tsx", "4.0.0"],
    ]);
  });

  it("skips comment and blank lines, and strips a trailing comment from a value", () => {
    const catalog = readCatalog(
      [
        "catalog: # the shared versions",
        "  # a note",
        "",
        "  ioredis: ^6.0.0 # dev version",
        "  pg: ^8.23.0",
      ].join("\n"),
    );
    expect([...catalog]).toEqual([
      ["ioredis", "^6.0.0"],
      ["pg", "^8.23.0"],
    ]);
  });

  it("keeps spaces inside a quoted value", () => {
    expect(readCatalog('catalog:\n  peer: "^1 || ^2"\n').get("peer")).toBe("^1 || ^2");
  });

  it("handles CRLF line endings", () => {
    const catalog = readCatalog("catalog:\r\n  hono: ^4.13.8\r\n  zod: ^4.6.5\r\n");
    expect([...catalog]).toEqual([
      ["hono", "^4.13.8"],
      ["zod", "^4.6.5"],
    ]);
  });

  it("stops at the next top-level key and does not merge later blocks", () => {
    const yaml = [
      "allowBuilds:",
      "  esbuild: true",
      "catalog:",
      "  hono: ^4.13.8",
      "catalogs:",
      "  legacy:",
      "    hono: ^3.0.0",
      "allowBuilds2:",
      "  zod: ^4.0.0",
    ].join("\n");
    expect([...readCatalog(yaml)]).toEqual([["hono", "^4.13.8"]]);
  });

  it("returns an empty map when there is no catalog block", () => {
    expect(readCatalog("packages:\n  - packages/*\n").size).toBe(0);
  });

  it("throws, naming the line, on an entry it cannot parse", () => {
    const yaml = ["catalog:", "  hono: ^4.13.8", "  weird: ^1 || ^2", "  zod: ^4.6.5"].join("\n");
    expect(() => readCatalog(yaml)).toThrow(
      /line 3: cannot parse this catalog entry: {3}weird: \^1 \|\| \^2/,
    );
  });

  it("throws on a nested mapping inside the block", () => {
    expect(() => readCatalog("catalog:\n  hono:\n    version: 1\n")).toThrow(/line 2/);
  });
});
