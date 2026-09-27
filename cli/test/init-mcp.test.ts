import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/init/index.js";

const FIXTURE = join(import.meta.dirname, "init", "fixtures", "sales.csv");
const noRun = { run: async () => 0 };

const tmpDirs: string[] = [];
function tmp(prefix = "kohaku-init-mcp-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("kohaku init --mcp", () => {
  it("generates the MCP front door on top of the REST front door", async () => {
    const out = join(tmp(), "app");
    const result = await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    for (const path of [
      "server/mcp-server.ts",
      "server/mcp.ts",
      "server/mcp-http.ts",
      // The REST front door is still generated (--mcp is additive, not a replacement).
      "server/ports.ts",
      "server/app.ts",
      "server/main.ts",
    ]) {
      expect(existsSync(join(out, path)), path).toBe(true);
    }
    expect(new Set(result.written).has(join(out, "server/mcp-server.ts"))).toBe(true);
  });

  it("adds the MCP dependencies and scripts to package.json", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies["@kohaku-ui/host-mcp-apps"]).toBeDefined();
    expect(pkg.dependencies["@kohaku-ui/mcp-renderer"]).toBeDefined();
    expect(pkg.dependencies["@modelcontextprotocol/server"]).toBeDefined();
    expect(pkg.dependencies["@modelcontextprotocol/node"]).toBeDefined();
    expect(pkg.scripts["mcp"]).toBe("tsx server/mcp.ts");
    expect(pkg.scripts["mcp:http"]).toBe("tsx server/mcp-http.ts");
  });

  it(".gitignore excludes .kohaku/ (self-contained snapshot HTML written next to the server files)", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).toContain(".kohaku/\n");
  });

  it("server/mcp.ts and server/mcp-http.ts resolve .env next to the file, not process.cwd()", async () => {
    // Claude Desktop launches an MCP server from an arbitrary working directory, so a cwd-relative
    // existsSync(".env") would silently miss the generated .env -- both entry points must resolve it via
    // import.meta.url instead.
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    for (const path of ["server/mcp.ts", "server/mcp-http.ts"]) {
      const src = readFileSync(join(out, path), "utf8");
      expect(src, path).toContain("fileURLToPath(import.meta.url)");
      // The cwd-relative form used elsewhere (server/app.ts) must not appear here -- only the
      // import.meta.url-resolved ENV_PATH constant may be passed to existsSync/loadEnvFile.
      expect(src, path).not.toContain('existsSync(".env")');
      expect(src, path).not.toContain('process.loadEnvFile(".env")');
    }
  });

  it("server/mcp-server.ts wires the pre-built renderer and a snapshot writer under .kohaku/snapshots", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    const src = readFileSync(join(out, "server/mcp-server.ts"), "utf8");
    expect(src).toContain('import { attachKohakuMcp } from "@kohaku-ui/host/mcp";');
    expect(src).toContain('import { loadRendererHtml } from "@kohaku-ui/mcp-renderer";');
    expect(src).toContain("rendererHtml: loadRendererHtml");
    expect(src).toContain(".kohaku");
    expect(src).toContain("snapshots");
  });

  it("server/mcp-server.ts exposes the generated Intent catalog as typed MCP tools", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    const src = readFileSync(join(out, "server/mcp-server.ts"), "utf8");
    expect(src).toContain('import { intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";');
    expect(src).toContain(
      "intentTools: intentToolsFromCatalog(INTENT_DEFINITIONS.map((d) => d.toToolSource()))",
    );
  });

  it("without --mcp, no MCP files/dependencies/scripts are generated (default behavior unchanged)", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false }, noRun);
    for (const path of ["server/mcp-server.ts", "server/mcp.ts", "server/mcp-http.ts"]) {
      expect(existsSync(join(out, path)), path).toBe(false);
    }
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    for (const dep of [
      "@kohaku-ui/host-mcp-apps",
      "@kohaku-ui/mcp-renderer",
      "@modelcontextprotocol/server",
      "@modelcontextprotocol/node",
    ]) {
      expect(pkg.dependencies[dep], dep).toBeUndefined();
    }
    expect(pkg.scripts["mcp"]).toBeUndefined();
    expect(readFileSync(join(out, ".gitignore"), "utf8")).not.toContain(".kohaku/");
  });
});
