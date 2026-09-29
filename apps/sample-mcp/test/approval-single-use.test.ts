import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmacApprovalPort, createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { actionPayloadHash } from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createKohakuMcpSetup } from "../src/setup.js";

const SECRET = "approval-single-use-secret";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  delete process.env["KOHAKU_STORAGE"];
  delete process.env["KOHAKU_CAPABILITY_SECRET"];
});

async function connect(setup: Awaited<ReturnType<typeof createKohakuMcpSetup>>): Promise<Client> {
  const server = setup.createServer();
  const client = new Client({ name: "approval-client", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

/**
 * The Streamable HTTP transport builds a fresh McpServer (via setup.createServer) for every request, so the
 * single-use ApprovalStore must live in the setup, not in createServer() (design.md #63).
 */
describe("createKohakuMcpSetup: approval tokens are single-use across createServer() instances", () => {
  it("rejects a consumed approval token replayed on a second server instance", async () => {
    process.env["KOHAKU_STORAGE"] = "memory";
    process.env["KOHAKU_CAPABILITY_SECRET"] = SECRET;
    const dir = mkdtempSync(join(tmpdir(), "kohaku-mcp-approval-"));
    tmpDirs.push(dir);
    const setup = await createKohakuMcpSetup({ llm: new FakeLlm({ objects: [] }), dataDir: dir });

    // The same secret the setup derives its ApprovalPort / AuthzPort from (capabilitySecretFromEnv).
    const requester = { id: "requester", roles: ["user"] };
    const capability = await createHmacAuthzPort(SECRET).issueCapability(requester, [
      { kind: "write", ref: "publish" },
    ]);
    const payload = {};
    const approval = await createHmacApprovalPort(SECRET).issueApproval({
      action: "publish",
      payloadHash: await actionPayloadHash(payload),
      approverId: "approver",
      requesterId: requester.id,
    });

    const first = await connect(setup);
    const ok = await first.callTool({
      name: "kohaku_action",
      arguments: { action: "publish", payload, capability, approval },
    });
    expect(ok.isError).toBeFalsy();
    await first.close();

    const second = await connect(setup);
    const replay = await second.callTool({
      name: "kohaku_action",
      arguments: { action: "publish", payload, capability, approval },
    });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.structuredContent)).toContain("approval already used");
    await second.close();
  });
});
