# Path (a): MCP Apps only

English | [日本語](mcp-apps.ja.md)

**Who this is for:** the author of an MCP server who wants their tools to answer with a *screen*, not a wall of text — in Claude Desktop, claude.ai or ChatGPT — and wants that screen to be the same one every time. You do not need a web app; the chat host is your UI.

**Time:** about 20 minutes to a typed tool that renders a widget, given a data API you can call.

## The first code

```bash
npm install @kohaku-ui/host-mcp-apps @kohaku-ui/registry @kohaku-ui/intents @kohaku-ui/llm @kohaku-ui/spec-core @modelcontextprotocol/server zod
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # the four Ports, as a file to fill in
```

```ts
import { readFile } from "node:fs/promises";
import { attachKohakuToMcpServer, intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { intents } from "./kohaku/intents.js"; // your Intent catalog (defineIntent)
import {
  authzPort as authz,
  domainPort as domain,
  semanticPort as semantic,
  storagePort as storage,
} from "./kohaku/ports.js"; // your four Ports (kohaku scaffold ports)

// The same Composition Service a REST host would use: one Spec per Intent, cached, whoever asks.
const compose = { catalog: resolveCatalog(coreCatalog), semantic, storage, llm: createLlmFromEnv() };
const server = new McpServer({ name: "my-product", version: "0.1.0" });
attachKohakuToMcpServer(
  server,
  { compose, domain, authz, querySource: "my-product" },
  {
    // The shared renderer bundle the host shows in its iframe (built once; see "The renderer" below).
    rendererHtml: () => readFile("./renderer/index.html", "utf8"),
    // One typed MCP tool per Intent (sales.summary → sales_summary), input schema derived from the Zod params.
    intentTools: intentToolsFromCatalog(intents.map((i) => i.toToolSource())),
  },
);
await server.connect(new StdioServerTransport());
```

Register it with a host — `claude mcp add my-product -- node ./server.js` for Claude Code / Claude Desktop — and call `sales_summary`. The host receives a UI Spec plus a text summary; an MCP Apps-capable host (Claude Desktop, claude.ai, ChatGPT) renders the Spec in an iframe with the bundled renderer, a terminal host that cannot draw an iframe (Claude Code, Codex CLI) gets the text fallback plus `kohaku_render_snapshot` for a self-contained HTML file.

What these three pieces are:

- **`ports.ts`** — the four Ports: `domain` (your data API: `listOperations` / `invoke`), `semantic` (Intent → `query://` handle, plus `dataVersion`), `authz` (capability tokens; the sample's ~50-line HMAC implementation is in `apps/sample-api/src/ports/authz-port.ts`), `storage` (an in-memory Map is enough to start). `kohaku scaffold ports` writes the file with a TODO per method. The [User guide §6, Step 0](../user-guide.md#step-0--server-driven-ui-without-an-llm) walks through each one.
- **`intents.ts`** — `defineIntent` once per Intent: canonical name, a Zod `params` schema, NL `examples`, and `queries`. The MCP tool, its input schema, and the SemanticPort definition all derive from that single definition.
- **`createLlmFromEnv()`** — reads `KOHAKU_LLM_PROVIDER` / the provider key (Claude / OpenAI / Gemini / Ollama / llama.cpp). Register fixed Specs in `policy.fixedSpecs` and the Intent never reaches the model at all — the widget still renders.

## The renderer

The iframe needs the shared renderer as a **single self-contained HTML file** (`rendererHtml`). Today that bundle is built from the repository's sample (`pnpm --filter @kohaku-ui-sample/mcp build:renderer` → `apps/sample-mcp/dist/renderer/index.html`; the source is the React widget under `apps/sample-mcp/renderer/`, built by the small `apps/sample-mcp/vite.renderer.config.ts` (Vite + `vite-plugin-singlefile`) around `@kohaku-ui/renderer-react`). Copy that build next to your server, or copy `apps/sample-mcp/renderer/` and its Vite config into your own project — [User guide §5](../user-guide.md#5-using-it-from-an-external-chat-mcp) has the host-by-host details (stdio vs Streamable HTTP, tunnels for claude.ai / ChatGPT, the snapshot fallback).

## What you get for free

- **Identical display**: the same Intent yields the same Spec whether it came from `sales_summary`'s arguments or from `kohaku_compose`'s natural-language text — cached, `provenance.cache: "hit"` the second time.
- **No data in the model's context**: the Spec carries `query://` references; the widget fetches rows through the app-only `kohaku_resolve_binding` tool with a capability scoped to those references. Only a text summary of what the user sees goes back to the model.
- **Host theme following**: on a host that provides `hostContext.theme` and/or its standard `--color-*` style variables, the widget adopts them with no configuration; otherwise it falls back to kohaku's default light theme.

## Next steps

- Serve the same Specs to a web app: [Path (b)](react-dashboard.md) (the React renderer) and `@kohaku-ui/host-rest` for the REST profile.
- Let the model compose within your catalog, and govern what it invents: [Path (c)](full-stack.md).
- Streamable HTTP for remote hosts, `kohaku_render_snapshot` for terminals, legacy `ui://` resources: [User guide §5](../user-guide.md#5-using-it-from-an-external-chat-mcp). The reference wiring is `apps/sample-mcp/src/setup.ts`.
