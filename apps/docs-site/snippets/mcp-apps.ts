import { readFile } from "node:fs/promises";
import { attachKohakuToMcpServer, intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { intents } from "./kohaku/intents.js"; // your Intent catalog (defineIntent)
import { authz, domain, semantic, storage } from "./kohaku/ports.js"; // your four Ports (kohaku scaffold ports)

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
