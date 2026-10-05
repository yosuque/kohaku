import { basename } from "node:path";
import type { InitResult } from "./index.js";

/** The `kohaku init` command-line flags the report depends on (the commander option bag, narrowed). */
export interface InitReportOptions {
  /** The `--name` flag: when it was not passed, a name derived from the directory is explained to the user. */
  name?: string | undefined;
  /** The `--mcp` flag: appends the MCP front-door hint. */
  mcp?: boolean | undefined;
}

/**
 * The text `kohaku init` prints after a successful run, as one string with its newlines (the caller does a
 * single `console.log`, which adds the final one): what was generated, the inferred profile, and the next
 * steps. The "next steps" / golden-update lines depend on `result.installed`; the MCP block on `opts.mcp`.
 */
export function formatInitResult(result: InitResult, opts: InitReportOptions): string {
  const p = result.profile;
  const lines: string[] = [];
  lines.push(`Generated ${result.written.length} files in ${result.outDir}`);
  if (opts.name == null && result.name !== basename(result.outDir)) {
    lines.push(
      `  name: ${result.name} (derived from directory "${basename(result.outDir)}"; pass --name to override)`,
    );
  }
  lines.push(`  source: ${p.source} (${p.rowCount} rows)`);
  lines.push(`  dimensions: ${p.dimensions.map((c) => c.name).join(", ")}`);
  lines.push(`  measures: ${p.measures.map((c) => c.name).join(", ") || "(none; row counts only)"}`);
  lines.push(`  time: ${p.time?.name ?? "(none; no trend view)"}`);
  if (p.unrecognizedDateColumns != null && p.unrecognizedDateColumns.length > 0) {
    lines.push(
      `  warning: column(s) ${p.unrecognizedDateColumns.join(", ")} look like dates but the format ` +
        "is ambiguous (e.g. MM/DD/YYYY vs DD/MM/YYYY), so no time axis was created; convert the column " +
        "to YYYY-MM-DD, the one unambiguous shape kohaku init recognizes, and run it again.",
    );
  }
  lines.push(
    `\nNext steps: ${result.installed ? "" : "npm install && "}npm run dev  →  http://localhost:5173`,
  );
  lines.push(
    "For chat and the LLM-composed views, edit .env (created for you with a capability secret) " +
      "and set a provider key; .env.example documents every variable.",
  );
  if (!result.installed)
    lines.push("KOHAKU_GOLDEN_UPDATE=1 npm test   # once after npm install, then npm test");
  if (opts.mcp === true) {
    lines.push(
      "\nMCP front door generated. To use it from Claude Desktop, run: npm run mcp:claude-desktop " +
        "(then restart Claude Desktop). `npm run mcp` (stdio) is the command Claude Desktop / Claude Code / " +
        "Codex CLI launch themselves -- you do not run it by hand. `npm run mcp:http` starts a Streamable HTTP " +
        "server on :8788 for claude.ai / ChatGPT.",
    );
  }
  return lines.join("\n");
}
