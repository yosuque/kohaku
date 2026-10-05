import { describe, expect, it } from "vitest";
import type { InitResult } from "../../src/init/index.js";
import type { ColumnProfile, DatasetProfile } from "../../src/init/infer.js";
import { formatInitResult } from "../../src/init/report.js";

function column(name: string, kind: ColumnProfile["kind"]): ColumnProfile {
  return { name, sourceName: name, type: "string", kind };
}

function profile(overrides: Partial<DatasetProfile> = {}): DatasetProfile {
  const region = column("region", "dimension");
  const product = column("product", "dimension");
  const revenue = column("revenue", "measure");
  const month = column("month", "time");
  return {
    source: "sales",
    columns: [region, product, revenue, month],
    dimensions: [region, product],
    measures: [revenue],
    time: month,
    rowCount: 120,
    ...overrides,
  };
}

function result(overrides: Partial<InitResult> = {}): InitResult {
  return {
    outDir: "/work/sales-app",
    written: ["a", "b", "c"],
    profile: profile(),
    installed: true,
    goldenGenerated: true,
    name: "sales-app",
    ...overrides,
  };
}

describe("formatInitResult", () => {
  it("prints the installed, name-matching, non-MCP run", () => {
    expect(formatInitResult(result(), {})).toBe(
      [
        "Generated 3 files in /work/sales-app",
        "  source: sales (120 rows)",
        "  dimensions: region, product",
        "  measures: revenue",
        "  time: month",
        "",
        "Next steps: npm run dev  →  http://localhost:5173",
        "For chat and the LLM-composed views, edit .env (created for you with a capability secret) and set a provider key; .env.example documents every variable.",
      ].join("\n"),
    );
  });

  it("explains a derived name, row-count-only measures and a missing time axis, and adds the install hints", () => {
    const text = formatInitResult(
      result({
        installed: false,
        name: "sales-dashboard",
        outDir: "/work/Sales Dashboard",
        profile: profile({ measures: [], time: null }),
      }),
      {},
    );
    expect(text).toBe(
      [
        "Generated 3 files in /work/Sales Dashboard",
        '  name: sales-dashboard (derived from directory "Sales Dashboard"; pass --name to override)',
        "  source: sales (120 rows)",
        "  dimensions: region, product",
        "  measures: (none; row counts only)",
        "  time: (none; no trend view)",
        "",
        "Next steps: npm install && npm run dev  →  http://localhost:5173",
        "For chat and the LLM-composed views, edit .env (created for you with a capability secret) and set a provider key; .env.example documents every variable.",
        "KOHAKU_GOLDEN_UPDATE=1 npm test   # once after npm install, then npm test",
      ].join("\n"),
    );
  });

  it("does not explain the name when --name was passed", () => {
    const text = formatInitResult(result({ name: "custom", outDir: "/work/other" }), { name: "custom" });
    expect(text).not.toContain("derived from directory");
  });

  it("warns about ambiguous date columns", () => {
    const text = formatInitResult(
      result({ profile: profile({ time: null, unrecognizedDateColumns: ["d1", "d2"] }) }),
      {},
    );
    expect(text).toContain(
      "\n  time: (none; no trend view)\n" +
        "  warning: column(s) d1, d2 look like dates but the format is ambiguous (e.g. MM/DD/YYYY vs DD/MM/YYYY), " +
        "so no time axis was created; convert the column to YYYY-MM-DD, the one unambiguous shape kohaku init " +
        "recognizes, and run it again.\n\nNext steps: ",
    );
  });

  it("omits the warning for an empty unrecognizedDateColumns list", () => {
    const text = formatInitResult(result({ profile: profile({ unrecognizedDateColumns: [] }) }), {});
    expect(text).not.toContain("warning:");
  });

  it("appends the MCP block after a blank line when --mcp was passed", () => {
    const text = formatInitResult(result(), { mcp: true });
    expect(
      text.endsWith(
        "variable.\n\nMCP front door generated. To use it from Claude Desktop, run: npm run mcp:claude-desktop " +
          "(then restart Claude Desktop). `npm run mcp` (stdio) is the command Claude Desktop / Claude Code / " +
          "Codex CLI launch themselves -- you do not run it by hand. `npm run mcp:http` starts a Streamable HTTP " +
          "server on :8788 for claude.ai / ChatGPT.",
      ),
    ).toBe(true);
    expect(formatInitResult(result(), { mcp: false })).not.toContain("MCP front door");
  });
});
