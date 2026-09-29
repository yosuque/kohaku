import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { loadPolicyFile } from "@kohaku-ui/host-core/policy-node";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { KohakuPolicyFile, UISpec } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// E2E for Policy as Code (design.md #69/#70, brief B3's acceptance criteria):
// - tenant-a (allowL2=false) never reaches L2, even for an intent whose routeTier forces a direct L2 entry.
// - tenant-b (dailyTokens=0) always falls back on the very first compose call (the budget check runs
//   pre-flight, before any LLM call).
// - Reloading the policy changes the compose fingerprint (a cache hit before reload becomes a miss after).
// All 3 exercise the actual shipped apps/sample-api/policy/kohaku.policy.json.

const POLICY_FILE_PATH = fileURLToPath(new URL("../policy/kohaku.policy.json", import.meta.url));

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function freshApp(policyFile: KohakuPolicyFile) {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-policy-"));
  tmpDirs.push(dir);
  const storage = createFileStoragePort(dir);
  const llm = new FakeLlm();
  const authz = createHmacAuthzPort("test-secret");
  return { ...(await createApp({ llm, storage, authz, policyFile })), storage };
}

/** A free-form request: compose-context.ts's shared routeTier forces sales.custom straight to L2 (no L1
 * attempt), so this is the only intent that exercises both the allowL2 gate and the L2 budget check
 * without any grammar-constrained L1 step in between. Sent as a direct {intent} (not NL text), so the
 * semantic port's normalize is never called either -- fully LLM-free regardless of outcome. */
function customBody(): unknown {
  return { intent: { canonical: "sales.custom", params: { request: "Sales as a calendar heatmap" } } };
}

function kpiOverviewBody(): unknown {
  return { intent: { canonical: "sales.kpi_overview", params: { fiscalYear: 2026 } } };
}

describe("sample-api Policy as Code E2E", () => {
  it("tenant-a (allowL2=false) never reaches L2: sales.custom falls back with the L2-disabled reason", async () => {
    const { file } = await loadPolicyFile(POLICY_FILE_PATH);
    const { app } = await freshApp(file);
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohaku-tenant": "tenant-a" },
      body: JSON.stringify(customBody()),
    });
    expect(res.status).toBe(200);
    const { spec } = (await res.json()) as { spec: UISpec };
    expect(spec.provenance.fallback?.reason).toContain("disabled in this environment");
  });

  it("tenant-b (dailyTokens=0) always falls back on the first call: sales.custom is budget-exceeded", async () => {
    const { file } = await loadPolicyFile(POLICY_FILE_PATH);
    const { app } = await freshApp(file);
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohaku-tenant": "tenant-b" },
      body: JSON.stringify(customBody()),
    });
    expect(res.status).toBe(200);
    const { spec } = (await res.json()) as { spec: UISpec };
    expect(spec.provenance.fallback?.reason).toContain("Budget exceeded");
  });

  it("a tenant the policy file does not mention is unaffected (allowL2 stays true, no budget cap)", async () => {
    const { file } = await loadPolicyFile(POLICY_FILE_PATH);
    const { app } = await freshApp(file);
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohaku-tenant": "tenant-c" },
      body: JSON.stringify(kpiOverviewBody()),
    });
    expect(res.status).toBe(200);
    const { spec } = (await res.json()) as { spec: UISpec };
    expect(spec.provenance.fallback).toBeUndefined();
    expect(spec.provenance.tier).toBe("L0");
  });

  it("reloading the policy changes the compose fingerprint (a cache hit before reload becomes a miss after)", async () => {
    const { file } = await loadPolicyFile(POLICY_FILE_PATH);
    const { app, policyRuntime } = await freshApp(file);
    expect(policyRuntime).toBeDefined();

    const compose = () =>
      app.request("/api/kohaku/compose", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kohaku-tenant": "tenant-a" },
        body: JSON.stringify(kpiOverviewBody()),
      });

    const first = (await (await compose()).json()) as { spec: UISpec };
    expect(first.spec.provenance.cache).toBe("miss");
    const second = (await (await compose()).json()) as { spec: UISpec };
    expect(second.spec.provenance.cache).toBe("hit");

    // Flip tenant-a's allowL2 from false to true (tierGate's fingerprint material changes:
    // {allowL2: false, ...} -> {allowL2: true, ...}), keeping every other field the same.
    const flipped: KohakuPolicyFile = {
      ...file,
      tenants: { ...file.tenants, "tenant-a": { compose: { allowL2: true } } },
    };
    await policyRuntime!.reload(flipped, "test");

    const third = (await (await compose()).json()) as { spec: UISpec };
    expect(third.spec.provenance.cache).toBe("miss");
    const fourth = (await (await compose()).json()) as { spec: UISpec };
    expect(fourth.spec.provenance.cache).toBe("hit");
  });

  it("records a policy.applied lineage event at startup (no actor, no previous policy), tenant-neutral", async () => {
    const { file } = await loadPolicyFile(POLICY_FILE_PATH);
    const { storage, policyRuntime } = await freshApp(file);

    const events = await storage.listLineage({ type: ["policy.applied"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload["policyId"]).toBe(policyRuntime!.policyId);
    expect(events[0]!.payload["previousPolicyId"]).toBeUndefined();
    expect("tenant" in events[0]!).toBe(false);
    expect(events[0]!.actor).toEqual({ kind: "system" }); // no operator id: lineage's own default system actor
  });

  it("records a policy.applied lineage event on reload, tenant-neutral", async () => {
    const { file } = await loadPolicyFile(POLICY_FILE_PATH);
    const { storage, policyRuntime } = await freshApp(file);
    const flipped: KohakuPolicyFile = {
      ...file,
      tenants: { ...file.tenants, "tenant-a": { compose: { allowL2: true } } },
    };
    await policyRuntime!.reload(flipped, "test-operator");

    const events = (await storage.listLineage({ type: ["policy.applied"] })).filter(
      (e) => e.payload["previousPolicyId"] !== undefined, // skip the startup event
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload["changedPaths"]).toContain("tenants.tenant-a.compose.allowL2");
    expect("tenant" in events[0]!).toBe(false);
    expect(events[0]!.actor).toEqual({ kind: "system", id: "test-operator" });
  });
});
