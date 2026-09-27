import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

describe("kohaku init --mcp: Claude Desktop config", () => {
  it("generates claude_desktop_config.example.json with absolute paths (Claude Desktop has no shell PATH)", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true, name: "sales-mcp-app" }, noRun);
    const configPath = join(out, "claude_desktop_config.example.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const entry = config.mcpServers["sales-mcp-app"];
    expect(entry).toBeDefined();
    expect(entry!.command).toBe(process.execPath);
    expect(entry!.args).toHaveLength(2);
    expect(entry!.args[0]).toBe(join(out, "node_modules", "tsx", "dist", "cli.mjs"));
    expect(entry!.args[1]).toBe(join(out, "server", "mcp.ts"));
  });

  it("does not generate claude_desktop_config.example.json without --mcp", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false }, noRun);
    expect(existsSync(join(out, "claude_desktop_config.example.json"))).toBe(false);
  });

  /** The subset of scripts/claude-desktop.mjs's exports these tests call (a plain generated .mjs, no .d.ts). */
  interface ClaudeDesktopScriptModule {
    syncClaudeDesktopConfig(options: {
      env?: Record<string, string | undefined>;
      plat?: string;
      printOnly?: boolean;
    }): {
      configPath: string;
      merged: { mcpServers: Record<string, unknown>; [key: string]: unknown };
      wrote: boolean;
      backedUp: boolean;
    };
    claudeDesktopConfigPath(env: Record<string, string | undefined>, plat: string): string;
  }

  describe("scripts/claude-desktop.mjs (imported directly, never touching a real Claude Desktop config)", () => {
    async function generate(): Promise<{ scriptModule: ClaudeDesktopScriptModule; out: string }> {
      const out = join(tmp(), "app");
      await initProject({ from: FIXTURE, out, install: false, mcp: true, name: "sales-mcp-app" }, noRun);
      const scriptUrl = pathToFileURL(join(out, "scripts", "claude-desktop.mjs")).href;
      const scriptModule = (await import(scriptUrl)) as unknown as ClaudeDesktopScriptModule;
      return { scriptModule, out };
    }

    it("--print (printOnly) computes the merge but writes nothing", async () => {
      const { scriptModule } = await generate();
      const fakeHome = tmp("kohaku-claude-home-");
      const result = scriptModule.syncClaudeDesktopConfig({
        env: { HOME: fakeHome },
        plat: "darwin",
        printOnly: true,
      });
      expect(result.wrote).toBe(false);
      expect(result.merged.mcpServers["sales-mcp-app"]).toBeDefined();
      expect(existsSync(result.configPath)).toBe(false);
    });

    it("first run writes the config with no .bak (nothing existed yet); a second run backs up and is idempotent", async () => {
      const { scriptModule } = await generate();
      const fakeHome = tmp("kohaku-claude-home-");

      const first = scriptModule.syncClaudeDesktopConfig({ env: { HOME: fakeHome }, plat: "darwin" });
      expect(first.wrote).toBe(true);
      expect(first.backedUp).toBe(false);
      expect(existsSync(first.configPath)).toBe(true);
      expect(existsSync(`${first.configPath}.bak`)).toBe(false);
      const afterFirst = readFileSync(first.configPath, "utf8");

      const second = scriptModule.syncClaudeDesktopConfig({ env: { HOME: fakeHome }, plat: "darwin" });
      expect(second.wrote).toBe(true);
      expect(second.backedUp).toBe(true);
      expect(existsSync(`${second.configPath}.bak`)).toBe(true);
      // The backup captures exactly what was there before this second run (= the first run's output).
      expect(readFileSync(`${second.configPath}.bak`, "utf8")).toBe(afterFirst);
      // Running it twice converges to the same result -- re-merging the same example changes nothing.
      const afterSecond = readFileSync(second.configPath, "utf8");
      expect(afterSecond).toBe(afterFirst);
      expect(second.merged).toEqual(first.merged);
    });

    it("preserves a pre-existing config's unrelated keys and other mcpServers entries", async () => {
      const { scriptModule } = await generate();
      const fakeHome = tmp("kohaku-claude-home-");
      const configPath = scriptModule.claudeDesktopConfigPath({ HOME: fakeHome }, "darwin");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            someOtherTopLevelSetting: true,
            mcpServers: { "someone-elses-server": { command: "/usr/bin/other", args: [] } },
          },
          null,
          2,
        ),
      );

      const result = scriptModule.syncClaudeDesktopConfig({ env: { HOME: fakeHome }, plat: "darwin" });
      expect(result.merged.someOtherTopLevelSetting).toBe(true);
      expect(result.merged.mcpServers["someone-elses-server"]).toEqual({
        command: "/usr/bin/other",
        args: [],
      });
      expect(result.merged.mcpServers["sales-mcp-app"]).toBeDefined();
    });
  });
});
