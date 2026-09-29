import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("server/mcp-http.ts builds the host once at module scope, not once per MCP exchange", async () => {
    // A host built inside the per-request McpServer factory would start every call with empty in-memory
    // storage (no Spec cache, fixation or lineage), so an L1 view would be regenerated on each call.
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    const http = readFileSync(join(out, "server/mcp-http.ts"), "utf8");
    expect(http.match(/createPorts\(/g)).toHaveLength(1);
    const factory = http.slice(http.indexOf("createMcpHandler(() =>"), http.indexOf("const handleMcp"));
    expect(factory).toContain("attachMcpServer(server, host)");
    expect(factory).not.toContain("createPorts");
    // attachMcpServer takes the host instead of building one itself.
    const mcpServer = readFileSync(join(out, "server/mcp-server.ts"), "utf8");
    expect(mcpServer).toContain("host: KohakuHost");
    expect(mcpServer).not.toContain("createPorts(");
    // stdio is one process = one host, so it builds it inline.
    expect(readFileSync(join(out, "server/mcp.ts"), "utf8")).toContain(
      "attachMcpServer(server, createPorts({ llm }))",
    );
  });

  it("server/mcp-http.ts validates Host and Origin, caps the body, and closes the handler with the server", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    const http = readFileSync(join(out, "server/mcp-http.ts"), "utf8");
    expect(http).toContain("hostHeaderValidation(");
    expect(http).toContain("originValidation(");
    expect(http).toContain("KOHAKU_MCP_ALLOWED_HOSTS");
    expect(http).toContain("KOHAKU_MCP_ALLOWED_ORIGINS");
    // Validation runs before anything else touches the request.
    expect(http.indexOf("validateHost(req, res)")).toBeLessThan(http.indexOf("handleMcp(req, res"));
    expect(http.indexOf("validateOrigin(req, res)")).toBeLessThan(http.indexOf("handleMcp(req, res"));
    // Never a wildcard CORS origin: only a validated Origin is echoed back.
    expect(http).not.toMatch(/Access-Control-Allow-Origin",\s*"\*"/);
    expect(http).toContain("MAX_BODY_BYTES = 4 * 1024 * 1024");
    expect(http).toMatch(/httpServer\.on\("close", \(\) => \{\s*void mcpHandler\.close\(\);/);
  });

  it("server/mcp-http.ts shuts down gracefully on SIGINT / SIGTERM and documents the port-agnostic Origin check", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, mcp: true }, noRun);
    const http = readFileSync(join(out, "server/mcp-http.ts"), "utf8");
    expect(http).toContain('for (const signal of ["SIGINT", "SIGTERM"] as const)');
    expect(http).toContain("httpServer.close();");
    expect(http).toContain("KOHAKU_SHUTDOWN_GRACE_MS");
    expect(http).toContain("port-agnostic");
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
      configPathOverride?: string;
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

    it("claudeDesktopConfigPath resolves a different, platform-shaped path per OS", async () => {
      const { scriptModule } = await generate();
      const fakeHome = tmp("kohaku-claude-home-");
      const darwinPath = scriptModule.claudeDesktopConfigPath({ HOME: fakeHome }, "darwin");
      const linuxPath = scriptModule.claudeDesktopConfigPath({ HOME: fakeHome }, "linux");
      const win32Path = scriptModule.claudeDesktopConfigPath({ HOME: fakeHome }, "win32");

      expect(darwinPath).toBe(
        join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      );
      expect(linuxPath).toBe(join(fakeHome, ".config", "Claude", "claude_desktop_config.json"));
      expect(win32Path).toBe(join(fakeHome, "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
      // All three differ -- this per-OS branching is exactly what caused the original CI bug (a test that
      // wrote a fixture at one platform's shape passed on that OS and silently no-op'd on every other).
      expect(new Set([darwinPath, linuxPath, win32Path]).size).toBe(3);
    });

    it("claudeDesktopConfigPath respects XDG_CONFIG_HOME (linux) and APPDATA (win32) overrides", async () => {
      const { scriptModule } = await generate();
      const fakeHome = tmp("kohaku-claude-home-");
      const xdgConfigHome = tmp("kohaku-xdg-config-");
      const appData = tmp("kohaku-appdata-");
      expect(
        scriptModule.claudeDesktopConfigPath({ HOME: fakeHome, XDG_CONFIG_HOME: xdgConfigHome }, "linux"),
      ).toBe(join(xdgConfigHome, "Claude", "claude_desktop_config.json"));
      expect(scriptModule.claudeDesktopConfigPath({ HOME: fakeHome, APPDATA: appData }, "win32")).toBe(
        join(appData, "Claude", "claude_desktop_config.json"),
      );
    });

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

    // Regression test: importing the module and calling syncClaudeDesktopConfig directly (the tests
    // above) never exercises the `isMain` / CLI-invocation branch at the bottom of the generated script,
    // which used a process.argv[1] vs. import.meta.url comparison that silently evaluated to false (main()
    // never ran, no error, no output) whenever the script's real path is reached through a symlink -- which
    // is exactly what os.tmpdir() is on macOS (/var/folders/... -> /private/var/folders/...), so this failed
    // for every generated project until the comparison started resolving process.argv[1] with realpathSync
    // first. A real `node scripts/claude-desktop.mjs --print` subprocess is the only way to catch that class
    // of bug (an import-only test cannot).
    it("running as a real subprocess (node scripts/claude-desktop.mjs --print) also works", async () => {
      const { out } = await generate();
      const fakeHome = tmp("kohaku-claude-home-");
      // Strip XDG_CONFIG_HOME/APPDATA from the inherited environment: on a CI runner that happens to have
      // either set, claudeDesktopConfigPath's own per-OS resolution would otherwise use that ambient
      // (real, outside-the-sandbox) value instead of falling back to env.HOME -- this test's whole point is
      // that nothing here ever reaches outside fakeHome, on any platform.
      const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome };
      delete env.XDG_CONFIG_HOME;
      delete env.APPDATA;
      const result = spawnSync(process.execPath, [join(out, "scripts", "claude-desktop.mjs"), "--print"], {
        env,
        encoding: "utf8",
      });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      const printed = JSON.parse(result.stdout);
      expect(printed.mcpServers["sales-mcp-app"]).toBeDefined();
      // printOnly never writes regardless of the resolved path, but confirm no directory materialized under
      // fakeHome for any of the three platform shapes claudeDesktopConfigPath could have picked.
      expect(existsSync(join(fakeHome, "Library"))).toBe(false);
      expect(existsSync(join(fakeHome, ".config"))).toBe(false);
      expect(existsSync(join(fakeHome, "AppData"))).toBe(false);
    });

    // A malformed *existing* config must abort rather than being silently treated as {} -- guessing a merge
    // target there would drop every one of the person's other registered MCP servers once written. Driven
    // through a real subprocess (not just importing syncClaudeDesktopConfig) so "exit code" and "stderr" are
    // the actual CLI-user-visible behavior, not just the exported function's own throw.
    //
    // The config path is pinned via KOHAKU_CLAUDE_DESKTOP_CONFIG (unit-level: configPathOverride) rather than
    // via claudeDesktopConfigPath's own per-OS detection -- a real subprocess always reports its own real
    // platform() regardless of what env.HOME is set to, so a test that instead wrote the broken file at (say)
    // the macOS-shaped path under a fake HOME would silently pass on macOS and silently no-op ("no config
    // found" -> a fresh one written successfully, exit 0) on Linux/Windows CI.
    describe.each([
      ["invalid JSON", "{ not valid json"],
      ["a JSON array at the top level", "[]"],
      ["JSON null at the top level", "null"],
      ["a non-object mcpServers field", JSON.stringify({ mcpServers: "not an object" })],
    ])("existing config is %s", (_label, brokenContent) => {
      function writeBrokenConfig(fakeHome: string): string {
        const configPath = join(fakeHome, "claude_desktop_config.json");
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, brokenContent);
        return configPath;
      }

      it("syncClaudeDesktopConfig throws, naming the file, instead of guessing {}", async () => {
        const { scriptModule } = await generate();
        const configPath = writeBrokenConfig(tmp("kohaku-claude-home-"));
        expect(() => scriptModule.syncClaudeDesktopConfig({ configPathOverride: configPath })).toThrow(
          configPath,
        );
      });

      it("the real CLI (node scripts/claude-desktop.mjs) exits non-zero, names the file, and writes/backs up nothing", async () => {
        const { out } = await generate();
        const fakeHome = tmp("kohaku-claude-home-");
        const configPath = writeBrokenConfig(fakeHome);
        const before = readFileSync(configPath, "utf8");

        const result = spawnSync(process.execPath, [join(out, "scripts", "claude-desktop.mjs")], {
          env: { ...process.env, HOME: fakeHome, KOHAKU_CLAUDE_DESKTOP_CONFIG: configPath },
          encoding: "utf8",
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(configPath);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(existsSync(`${configPath}.bak`)).toBe(false);
      });
    });
  });
});
