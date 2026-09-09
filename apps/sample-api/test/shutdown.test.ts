import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { FixationRecord, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createHmacAuthzPort } from "../src/ports/authz-port.js";

// Graceful shutdown (ops): setShuttingDown flips GET /api/health to a 503 readiness signal so a load balancer
// stops routing new traffic during the drain window, ahead of the server actually closing. index.ts wires this
// to SIGINT/SIGTERM; this test exercises the same flag through the exported hook so it does not have to send a
// real signal to the test process.

function makeMemoryStorage() {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(key: string) {
      return cache.get(key) ?? null;
    },
    async putSpecCache(key: string, spec: UISpec) {
      cache.set(key, spec);
    },
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation(): Promise<FixationRecord | null> {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

async function makeTestApp() {
  return createApp({
    llm: new FakeLlm({ objects: [] }),
    storage: makeMemoryStorage(),
    authz: createHmacAuthzPort("test-secret"),
  });
}

describe("graceful shutdown readiness (GET /api/health)", () => {
  it("reports ok:true before setShuttingDown is called", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("reports 503 {ok:false, reason:'shutting down'} once setShuttingDown(true) is called", async () => {
    const { app, setShuttingDown } = await makeTestApp();
    setShuttingDown(true);
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: "shutting down" });
  });

  it("setShuttingDown(false) restores normal 200 health reporting", async () => {
    const { app, setShuttingDown } = await makeTestApp();
    setShuttingDown(true);
    setShuttingDown(false);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  it("the shuttingDown flag is scoped per createApp instance (does not leak across apps)", async () => {
    const a = await makeTestApp();
    const b = await makeTestApp();
    a.setShuttingDown(true);
    expect((await a.app.request("/api/health")).status).toBe(503);
    expect((await b.app.request("/api/health")).status).toBe(200);
  });
});
