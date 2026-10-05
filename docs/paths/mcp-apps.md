# Path (a): MCP Apps only

English | [日本語](mcp-apps.ja.md)

kohaku puts LLM-generated UI under control in production: the same request on the same data version gets the same screen, no row of your data ever enters the model's context, and whatever it invents has to pass review before it becomes an official part.

**Who this is for:** the author of an MCP server who wants their tools to answer with a *screen*, not a wall of text — in Claude Desktop, claude.ai or ChatGPT — and wants that screen to be the same one every time. You do not need a web app; the chat host is your UI.

**Time:** about 20 minutes to a typed tool that renders a widget, given a data API you can call. Already
have a data file instead of a live API? `npx @kohaku-ui/cli init --mcp --from data.csv --out app` generates
all of this for you in one shot -- see "Even faster: from a CSV" below.

## The first code

```bash
npm install @kohaku-ui/host @kohaku-ui/host-mcp-apps @kohaku-ui/intents @kohaku-ui/llm @kohaku-ui/mcp-renderer @kohaku-ui/spec-core @modelcontextprotocol/server zod
npm install -D tsx
npm pkg set type=module                            # server.ts uses top-level await, which needs ESM
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # a DomainPort + an Intent catalog, as files to fill in
```

`scaffold ports` also writes `kohaku/server.ts`, a REST host on `@hono/node-server` (not installed above). This path does not use it — the MCP server below replaces it — so delete it or leave it alone; don't start it.

```ts
import { createKohakuHost } from "@kohaku-ui/host";
import { attachKohakuMcp } from "@kohaku-ui/host/mcp";
import { intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { loadRendererHtml } from "@kohaku-ui/mcp-renderer";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { intents } from "./kohaku/intents.js"; // your hand-written Intent catalog (defineIntent)
import { domainPort as domain } from "./kohaku/ports.js"; // your DomainPort (kohaku scaffold ports)

const host = createKohakuHost({
  domain,
  querySource: "my-product", // must equal the `source` of every Intent in intents.ts
  llm: createLlmFromEnv(),
  intents: intents.map((i) => i.toIntentDef()),
  dataVersion: () => "my-product@1",
});
const server = new McpServer({ name: "my-product", version: "0.1.0" });
attachKohakuMcp(server, host, {
  // Pre-built, dependency-free core renderer bundle -- swap for your own build once you have
  // product-specific component implementations to bake in (see @kohaku-ui/mcp-renderer's README).
  rendererHtml: loadRendererHtml,
  // One typed MCP tool per Intent (sales.summary → sales_summary), input schema derived from the Zod params.
  intentTools: intentToolsFromCatalog(intents.map((i) => i.toToolSource())),
});
await server.connect(new StdioServerTransport());
```

Save it as `server.ts`. You do not start it yourself: an MCP host launches it as a child process (stdio) whenever you open a chat.

**Two things must line up before the first call:**

- **The source name.** `querySource` must equal the `source` of every Intent in `intents.ts`, or the widget's data read is refused with `SOURCE_MISMATCH` (the error message names the source the host serves). `kohaku scaffold ports` writes the placeholder `"example"`; the snippet uses `"my-product"` — pick one name and use it in both files.
- **The capability secret.** Capability tokens are signed with `KOHAKU_CAPABILITY_SECRET`; `createKohakuHost` throws without one. Pass any long random string in the registration below (`openssl rand -base64 32`). For a quick local trial you can instead add `dev: true` to `createKohakuHost`, which generates a temporary secret for the process and warns on stderr — never in production. `KOHAKU_LLM_PROVIDER` and a provider key are only needed once an Intent reaches the model (L1/L2); the L0 path does not call it.

**Register it with a host.** The tool for each Intent is its canonical name with the dot replaced by an underscore (`sales.summary` in the snippet → `sales_summary`; the scaffold's placeholder `example.summary` → `example_summary`).

- **Claude Code:** `claude mcp add --env KOHAKU_CAPABILITY_SECRET=<secret> my-product -- npx tsx ./server.ts`
- **Claude Desktop** does not read `claude mcp add`; edit its `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and restart Claude Desktop. It does not inherit your shell's `PATH`, so `npx` would not resolve either: launch `node` on tsx's own entry point, with absolute paths throughout (`kohaku init --mcp` generates the same form):

```json
{
  "mcpServers": {
    "my-product": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/node_modules/tsx/dist/cli.mjs", "/absolute/path/to/server.ts"],
      "env": { "KOHAKU_CAPABILITY_SECRET": "<secret>" }
    }
  }
}
```

Then ask the model to call `sales_summary` (or whichever tool your catalog produced). The host receives a UI Spec plus a text summary; an MCP Apps-capable host (Claude Desktop, claude.ai, ChatGPT) renders the Spec in an iframe with the bundled renderer, a terminal host that cannot draw an iframe (Claude Code, Codex CLI) gets the text fallback. `kohaku_render_snapshot` (a self-contained HTML file for such hosts) is registered only when you pass `snapshotWriter` to `attachKohakuMcp` — the snippet above does not, so add one (a function that writes the HTML somewhere and returns its path; `kohaku init --mcp`'s generated server is an example) to enable it.

What these three pieces are:

- **`ports.ts`** — the one Port every product still writes by hand: `domain` (your data API: `listOperations` / `invoke`). `createKohakuHost` supplies working defaults for the other three (an in-memory `storage`, HMAC `authz`, and a `semantic` built from `intents.ts` below) — override any of them once you outgrow the default (see [`@kohaku-ui/host`'s README](https://github.com/yosuque/kohaku/tree/main/packages/host#readme)). `kohaku scaffold ports` writes the file with a TODO. The [User guide §6, Step 0](../user-guide.md#step-0--server-driven-ui-without-an-llm) walks through the four Ports this replaces defaults for.
- **`intents.ts`** — your Intent catalog, also written by `kohaku scaffold ports`: `defineIntent` once per Intent: canonical name, a Zod `params` schema, NL `examples`, and `queries`. The MCP tool, its input schema, and `createKohakuHost`'s default SemanticPort all derive from that single definition.
- **`createLlmFromEnv()`** — reads `KOHAKU_LLM_PROVIDER` / the provider key (Claude / OpenAI / Gemini / Ollama / llama.cpp). Register fixed Specs in `policy` (an option of `createKohakuHost`) and the Intent never reaches the model at all — the widget still renders.

## The renderer

The iframe needs the shared renderer as a **single self-contained HTML file** (`rendererHtml`). `@kohaku-ui/mcp-renderer`'s `.` entry point (`loadRendererHtml`, used above) ships exactly that: pre-built, with the core kohaku component set, and **zero npm dependencies** of its own — nothing to build yourself. Once you have product-specific component implementations to bake in (the same registry overlay a web app's own renderer uses), rebuild your own bundle against `@kohaku-ui/mcp-renderer/boot`'s `bootMcpRenderer` instead — see that package's README, or `apps/sample-mcp/renderer/main.tsx` for a worked example — and pass `rendererHtml: () => readFile("./dist/renderer.html", "utf8")` (or an equivalent loader for wherever you serve that build from).

## What you get for free

- **Identical display**: the same Intent yields the same Spec whether it came from `sales_summary`'s arguments or from `kohaku_compose`'s natural-language text — cached, `provenance.cache: "hit"` the second time.
- **No data in the model's context**: the Spec carries `query://` references; the widget fetches rows through the app-only `kohaku_resolve_binding` tool with a capability scoped to those references. Only a text summary of what the user sees goes back to the model.
- **Host theme following**: on a host that provides `hostContext.theme` and/or its standard `--color-*` style variables, the widget adopts them with no configuration; otherwise it falls back to kohaku's default light theme.

## Even faster: from a CSV

Already have a data file (CSV / JSON / SQLite) instead of a live API? Skip everything above:

```bash
npx @kohaku-ui/cli init --mcp --from data.csv --out app
npm --prefix app run mcp:claude-desktop
# restart Claude Desktop
```

This generates a DomainPort, an Intent catalog, both the stdio and Streamable HTTP MCP servers (wired onto `@kohaku-ui/mcp-renderer`'s core renderer, exactly like the hand-written example above), and a `claude_desktop_config.example.json` -- `mcp:claude-desktop` merges that into Claude Desktop's own config (backing the existing one up to `.bak` first; `-- --print` previews the merge without writing anything). Restarting Claude Desktop is the only manual step left before you can ask it about your data. The generated project's README documents `npm run mcp:http` (for claude.ai / ChatGPT) and the `kohaku_render_snapshot` fallback for terminal hosts.

## Next steps

- Serve the same Specs to a web app: [Path (b)](react-dashboard.md) (the React renderer) — `host.app` above already is a REST host (`@kohaku-ui/host-rest` under the hood); mount it with `@hono/node-server`'s `serve()`.
- Let the model compose within your catalog, and govern what it invents: [Path (c)](full-stack.md).
- Streamable HTTP for remote hosts, `kohaku_render_snapshot` for terminals, legacy `ui://` resources: [User guide §5](../user-guide.md#5-using-it-from-an-external-chat-mcp). The reference wiring is `apps/sample-mcp/src/setup.ts`.
