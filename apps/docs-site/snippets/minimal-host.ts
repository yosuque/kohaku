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
  querySource: "my-product",
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
