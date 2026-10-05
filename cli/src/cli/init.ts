import type { Command } from "commander";
import type { InitResult } from "../init/index.js";
import { fail } from "./shared.js";

/** Registers `kohaku init`. The runner module is loaded lazily by the action. */
export function register(program: Command): void {
  program
    .command("init")
    .description(
      "Generate a runnable kohaku app (server + dashboard + chat) from a data file, then npm install",
    )
    .requiredOption("--from <file>", "Data file: .csv, .json (array of objects) or .sqlite / .db")
    .option("--out <dir>", "Output directory (default: the current directory)")
    .option("--source <name>", "Intent catalog prefix / query source (default: the data file's basename)")
    .option("--name <name>", "package.json name (default: the output directory's basename)")
    .option("--table <name>", "SQLite table to read (default: the first user table)")
    .option("--no-install", "Skip npm install")
    .option(
      "--mcp",
      "Also generate the MCP front door (stdio + Streamable HTTP servers, for Claude Desktop / claude.ai / ChatGPT)",
    )
    .action(
      async (opts: {
        from: string;
        out?: string;
        source?: string;
        name?: string;
        table?: string;
        install: boolean;
        mcp?: boolean;
      }) => {
        const { formatInitResult, initProject } = await import("../init/index.js");
        let result: InitResult;
        try {
          result = await initProject(opts);
        } catch (e) {
          fail(program, e);
        }
        console.log(formatInitResult(result, opts));
      },
    );
}
