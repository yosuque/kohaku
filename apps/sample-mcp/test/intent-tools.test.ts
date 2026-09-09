import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachKohakuToMcpServer, intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { createApp } from "@kohaku-ui-sample/api";
import { createHmacAuthzPort } from "@kohaku-ui-sample/api/ports/authz-port";
import { createFileStoragePort } from "@kohaku-ui-sample/api/ports/storage-port";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const dataDirs: string[] = [];

afterAll(async () => {
  await Promise.all(dataDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Regression guard for sample-mcp's wiring (intentToolsFromCatalog(intentCatalog.list())).
 * Confirms that all 7 core Intents are exposed to MCP as typed intent tools with normalized naming, and
 * that promoted ones (intentCatalog.add) are also turned into tools via the same path (static at startup).
 */
async function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-intent-tools-"));
  dataDirs.push(dataDir);
  const storage = createFileStoragePort(dataDir);
  const authz = createHmacAuthzPort("test-secret");
  const llm = new FakeLlm({ objects: [] });
  return { ...(await createApp({ llm, storage, authz })), authz };
}

async function connectServer(app: Awaited<ReturnType<typeof makeApp>>): Promise<Client> {
  const server = new McpServer({ name: "kohaku-test", version: "0.1.0" });
  attachKohakuToMcpServer(
    server,
    { compose: app.composeCtx, domain: app.domain, authz: app.authz, querySource: "sales" },
    {
      rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
      intentTools: intentToolsFromCatalog(app.intentCatalog.list()),
    },
  );
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const CORE_TOOL_NAMES = [
  "sales_quarterly_summary",
  "sales_trend",
  "sales_by_product",
  "sales_kpi_overview",
  "sales_records",
  "sales_target_attainment",
  "sales_custom",
];

describe("sample-mcp: Intent catalog to typed intent tool auto-generation", () => {
  it("all 7 core Intents are registered as model-visible typed tools", async () => {
    const app = await makeApp();
    const client = await connectServer(app);

    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    // Not just the single one from the hand-written era, but all 7 appear (separate from the generic kohaku_compose).
    for (const expected of CORE_TOOL_NAMES) {
      expect(names.has(expected), `${expected} is registered`).toBe(true);
    }

    // quarterly_summary's inputSchema reflects the catalog's Zod params.
    const summary = tools.find((t) => t.name === "sales_quarterly_summary")!;
    const schema = summary.inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties["groupBy"]!.enum).toEqual(["region", "product", "channel"]);

    await client.close();
  });

  it("promoted dynamic Intents also become tools when merged into the catalog (static at startup)", async () => {
    const app = await makeApp();
    // Equivalent to promotion (publish): mimic an Intent already merged into intentCatalog at startup.
    app.intentCatalog.add({
      name: "sales.promoted_demo",
      description: "Promotion demo Intent",
      params: z.object({ fiscalYear: z.coerce.number().int().default(2026) }),
      examples: [],
      toQueries: () => [],
    });
    const client = await connectServer(app);

    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("sales_promoted_demo")).toBe(true);
    // The core ones all still appear.
    for (const expected of CORE_TOOL_NAMES) {
      expect(names.has(expected)).toBe(true);
    }

    await client.close();
  });
});
