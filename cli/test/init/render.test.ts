import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferProfile, normalizeRows } from "../../src/init/infer.js";
import { readDataFile } from "../../src/init/readers.js";
import {
  renderDataset,
  renderFixedSpecs,
  renderGoldenFixture,
  renderIntents,
  renderPackageJson,
  renderProjectFiles,
} from "../../src/init/render.js";
import { EXTERNAL_VERSIONS } from "../../src/init/versions.js";
import { CLI_VERSION } from "../../src/version.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "sales.csv");

async function profileOf() {
  const dataset = await readDataFile(FIXTURE);
  const profile = inferProfile("sales", dataset);
  return { dataset, profile, rows: normalizeRows(dataset, profile) };
}

describe("renderIntents", () => {
  it("declares one vocabulary per dimension, metric / agg / groupBy / granularity, and summary + trend + records", async () => {
    const { profile } = await profileOf();
    const src = renderIntents(profile);
    expect(src).toContain('export const SOURCE = "sales";');
    expect(src).toContain(
      'export const region = defineVocabulary("region", {\n  japan: "Japan",\n  north_america: "North america",\n  europe: "Europe",\n});',
    );
    expect(src).toContain(
      'export const metric = defineVocabulary("metric", {\n  units: "Units",\n  revenue: "Revenue",\n  count: "Row count",\n});',
    );
    expect(src).toContain('canonical: "sales.summary"');
    expect(src).toContain('canonical: "sales.trend"');
    expect(src).toContain('canonical: "sales.records"');
    expect(src).toContain('granularity: granularity.enum().default("month")');
  });

  it("omits trend and granularity when there is no time column", async () => {
    const { dataset } = await profileOf();
    const noTime = {
      columns: dataset.columns.filter((c) => c !== "month"),
      rows: dataset.rows.map(({ month: _m, ...rest }) => rest),
    };
    const src = renderIntents(inferProfile("sales", noTime));
    expect(src).not.toContain("sales.trend");
    expect(src).not.toContain("granularity");
  });

  it("renames a dimension column whose slug collides with a top-level binding the file itself introduces", async () => {
    const { dataset } = await profileOf();
    // "z" slugifies to itself and would otherwise collide with `import { z } from "zod"`.
    const zValues = ["alpha", "beta", "alpha", "beta", "alpha", "beta"];
    const withZ = {
      columns: [...dataset.columns, "z"],
      rows: dataset.rows.map((row, i) => ({ ...row, z: zValues[i] })),
    };
    const src = renderIntents(inferProfile("sales", withZ));
    // The zod import is untouched...
    expect(src).toContain('import { z } from "zod";');
    // ...and no top-level binding named plain `z` is declared (only `zVocab`).
    expect(src).not.toMatch(/^export const z =/m);
    expect(src).toContain(
      'export const zVocab = defineVocabulary("z", {\n  alpha: "Alpha",\n  beta: "Beta",\n});',
    );
    // The column is still wired to its (renamed) vocabulary everywhere it's used.
    expect(src).toContain("z: zVocab.enum().optional()");
    expect(src).toContain('{ param: "z", label: "Z", options: zVocab, emptyLabel: "All" }');
  });
});

describe("renderDataset", () => {
  it("declares every export the other server templates import from it, with COLUMNS reflecting the profile", async () => {
    const { profile } = await profileOf();
    const src = renderDataset(profile);
    // Every name DOMAIN_PORT_TEMPLATE / FIXED_SPECS_TEMPLATE / APP_TEMPLATE import from "./dataset.js".
    expect(src).toContain("export type Cell = string | number | boolean | null;");
    expect(src).toContain("export type Row = Record<string, Cell>;");
    expect(src).toContain("export const COLUMNS: Columns = {");
    expect(src).toContain("export const ROWS: Row[] = JSON.parse(raw) as Row[];");
    // Split around the interpolation so this string literal never itself contains a `${...}`
    // (Biome's noTemplateCurlyInString rule flags a plain string that looks like a forgotten
    // template literal; here it genuinely is the literal generated source text).
    expect(src).toContain("export const DATA_VERSION = `sales@");
    expect(src).toContain('createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;');
    // COLUMNS reflects this profile's actual dimension / measure / time columns.
    expect(src).toContain('  source: "sales",');
    expect(src).toContain('  dimensions: ["region", "channel", "product"],');
    expect(src).toContain('  measures: ["units", "revenue"],');
    expect(src).toContain('  time: "month",');
  });

  it("emits a null time field when there is no time column", async () => {
    const { dataset } = await profileOf();
    const noTime = {
      columns: dataset.columns.filter((c) => c !== "month"),
      rows: dataset.rows.map(({ month: _m, ...rest }) => rest),
    };
    const src = renderDataset(inferProfile("sales", noTime));
    expect(src).toContain("  time: null,");
  });
});

describe("renderFixedSpecs / renderGoldenFixture", () => {
  it("fixes <source>.summary as L0 and the golden fixture targets it with no drafts", async () => {
    const { profile } = await profileOf();
    expect(renderFixedSpecs(profile)).toContain('"sales.summary": summaryView');
    const fixture = JSON.parse(renderGoldenFixture(profile)) as {
      input: { intent: { canonical: string } };
      drafts: unknown[];
      expected: null;
    };
    expect(fixture.input.intent.canonical).toBe("sales.summary");
    expect(fixture.drafts).toEqual([]);
    expect(fixture.expected).toBeNull();
  });
});

describe("renderPackageJson", () => {
  it("pins @kohaku-ui/* to the CLI's own version and never uses workspace: ranges", async () => {
    const { profile } = await profileOf();
    const pkg = JSON.parse(renderPackageJson("my-app", profile)) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies["@kohaku-ui/host-rest"]).toBe(`^${CLI_VERSION}`);
    expect(pkg.dependencies["@kohaku-ui/semantic-llm"]).toBe(`^${CLI_VERSION}`);
    expect(pkg.dependencies["@kohaku-ui/storage-memory"]).toBe(`^${CLI_VERSION}`);
    expect(pkg.dependencies["@kohaku-ui/authz-hmac"]).toBe(`^${CLI_VERSION}`);
    expect(
      Object.values({ ...pkg.dependencies, ...pkg.devDependencies }).some(
        (v) => v.startsWith("workspace:") || v.startsWith("catalog:"),
      ),
    ).toBe(false);
    expect(pkg.scripts["dev"]).toBe("node dev.mjs");
  });
});

describe("EXTERNAL_VERSIONS", () => {
  it("matches the pnpm catalog so the generated project uses the versions this repo tests against", () => {
    const yaml = readFileSync(join(import.meta.dirname, "../../../pnpm-workspace.yaml"), "utf8");
    // Catalog lines look like `  hono: ^4.13.8` or `  "@hono/node-server": ^2.1.1` (scoped names are quoted).
    const catalog = new Map<string, string>();
    for (const line of yaml.split("\n")) {
      const m = /^\s{2}"?([^":\s]+)"?:\s*(\S+)\s*$/.exec(line);
      if (m != null) catalog.set(m[1]!, m[2]!);
    }
    for (const [name, version] of Object.entries(EXTERNAL_VERSIONS)) {
      expect(catalog.get(name), `${name} is not in the catalog`).toBe(version);
    }
  });
});

describe("renderProjectFiles", () => {
  it("emits the full project layout with the normalized data file", async () => {
    const { profile, rows } = await profileOf();
    const files = renderProjectFiles(profile, rows, { name: "my-app" });
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        ".env.example",
        ".gitignore",
        "README.md",
        "data/sales.json",
        "dev.mjs",
        "index.html",
        "package.json",
        "server/app.ts",
        "server/dataset.ts",
        "server/domain-port.ts",
        "server/fixed-specs.ts",
        "server/intents.ts",
        "server/main.ts",
        "test/golden.test.ts",
        "test/golden/summary.json",
        "tsconfig.json",
        "vite.config.ts",
        "web/main.tsx",
      ].sort(),
    );
    expect(JSON.parse(files.find((f) => f.path === "data/sales.json")!.content)).toHaveLength(6);
  });
});
