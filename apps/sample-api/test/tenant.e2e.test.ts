import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// sample-api wiring test for the multi-tenant contract.
// The x-kohaku-tenant header -> KohakuHostDeps.tenant -> SessionContext.tenant -> lineage recording all the way through.
// Per-tenant fixation isolation is covered by storage-port.test.ts / host-rest's tenant.test.ts.

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-tenant-"));
  tmpDirs.push(dir);
  const storage = createFileStoragePort(dir);
  const llm = new FakeLlm();
  const authz = createHmacAuthzPort("test-secret");
  return { ...(await createApp({ llm, storage, authz })), storage };
}

// A canonical view (L0 fixed Spec). Composable without calling the LLM.
const QUARTERLY_GUI = {
  input: {
    kind: "gui",
    action: "view.select",
    params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
};

describe("sample-api tenant wiring", () => {
  it("compose with the x-kohaku-tenant header stamps tenant on view.composed", async () => {
    const { app, storage } = await freshApp();
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohaku-tenant": "acme" },
      body: JSON.stringify(QUARTERLY_GUI),
    });
    expect(res.status).toBe(200);

    const composed = await storage.listLineage({ type: ["view.composed"] });
    expect(composed).toHaveLength(1);
    expect(composed[0]!.tenant).toBe("acme");
    // A tenant-scoped listLineage shows only acme and not other tenants.
    expect(await storage.listLineage({ type: ["view.composed"], tenant: "acme" })).toHaveLength(1);
    expect(await storage.listLineage({ type: ["view.composed"], tenant: "globex" })).toHaveLength(0);
  });

  it("compose without the header does not stamp tenant (single-tenant regression)", async () => {
    const { app, storage } = await freshApp();
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(QUARTERLY_GUI),
    });
    expect(res.status).toBe(200);

    const composed = await storage.listLineage({ type: ["view.composed"] });
    expect(composed).toHaveLength(1);
    expect("tenant" in composed[0]!).toBe(false);
  });
});
