import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { attachKohakuToMcpServer } from "@kohaku-ui/host-mcp-apps";
import { createViewRecorder } from "@kohaku-ui/lineage";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { createApp } from "@kohaku-ui-sample/api";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Regression guard that the MCP surface's compose merges into View Lineage.
 * Builds the same wiring as index.ts (createApp → createViewRecorder(lineage) → onComposed), hits an
 * intent tool (L0 fixed Spec / no LLM) once, and confirms that view.composed remains with surface="mcp-app".
 */
describe("MCP compose to View Lineage integration (regression guard)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-lineage-"));

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("view.composed is recorded with surface=mcp-app after an intent tool runs", async () => {
    const storage = createFileStoragePort(dataDir);
    const authz = createHmacAuthzPort("test-secret");
    // Only the L0 fixed-Spec path is hit, so the LLM is not called (an empty script is enough).
    const llm = new FakeLlm({ objects: [] });

    const { composeCtx, domain, lineage } = await createApp({ llm, storage, authz });
    const recorder = createViewRecorder(lineage);

    const server = new McpServer({ name: "kohaku-test", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: composeCtx,
        domain,
        authz,
        querySource: "sales",
        fixationLookup: (intentHash) => storage.getFixation(intentHash),
        onComposed: (spec, trace) => recorder.composed({ spec, trace, surface: "mcp-app" }),
      },
      {
        rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
        intentTools: [
          {
            name: "sales_quarterly_summary",
            description: "Quarterly sales summary",
            paramsShape: {},
            toIntent: () => ({
              canonical: "sales.quarterly_summary",
              params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
            }),
          },
        ],
      },
    );

    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "sales_quarterly_summary", arguments: {} });
    expect(result.isError).not.toBe(true);

    const events = await lineage.list({ type: ["view.composed"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload["surface"]).toBe("mcp-app");
    expect(events[0]!.payload["canonical"]).toBe("sales.quarterly_summary");

    await client.close();
  });
});
