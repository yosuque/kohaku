import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { LineageEventRecord, LineageFilter, UISpec } from "@kohaku-ui/spec-core";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/** An in-memory StoragePort that captures lineage events (observes view.fallback records). */
function makeLineageStorage() {
  const specCache = new Map<string, UISpec>();
  const events: LineageEventRecord[] = [];
  return {
    events,
    async getSpecCache(key: string) {
      return specCache.get(key) ?? null;
    },
    async putSpecCache(key: string, spec: UISpec) {
      specCache.set(key, spec);
    },
    async appendLineage(event: LineageEventRecord) {
      events.push(event);
    },
    async listLineage(filter: LineageFilter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      if (filter.artifactId != null)
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
      return result.slice(-(filter.limit ?? 200));
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

async function composeJson(app: Hono, body: unknown) {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as { spec: UISpec; capability: string } };
}

const TREND_GUI = {
  input: { kind: "gui", action: "view.select", params: { intent: "sales.trend" } },
  session: { surface: "web", sessionId: "sess-1" },
};

const QUARTERLY_GUI = {
  input: {
    kind: "gui",
    action: "view.select",
    params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
};

describe("view.fallback lineage wiring (REST)", () => {
  it("a compose where all L1/L2 generation fails records one view.fallback (kind:generation)", async () => {
    // Empty FakeLlm: sales.trend tries L1 -> (allowL2) L2, both fail, and falls to the deterministic fallback.
    const storage = makeLineageStorage();
    const { app } = await createApp({
      llm: new FakeLlm({ objects: [] }),
      storage,
      authz: createHmacAuthzPort("test-secret"),
    });

    const { res, json } = await composeJson(app, TREND_GUI);
    expect(res.status).toBe(200);
    // Confirm it is a fallback Spec (deterministic demotion on generation failure)
    expect(json.spec.provenance.fallback?.kind).toBe("generation");

    const fallbacks = storage.events.filter((e) => e.type === "view.fallback");
    expect(fallbacks).toHaveLength(1);
    const payload = fallbacks[0]!.payload;
    expect(payload["kind"]).toBe("generation");
    expect(payload["intentHash"]).toBe(json.spec.intent.hash);
    expect(payload["surface"]).toBe("web");
    expect(payload["sessionId"]).toBe("sess-1");
    expect(typeof payload["specHash"]).toBe("string");
    expect(typeof payload["reason"]).toBe("string");
    expect((payload["reason"] as string).length).toBeGreaterThan(0);
  });

  it("a successful compose (L0 fixed Spec) does not record view.fallback", async () => {
    const storage = makeLineageStorage();
    const { app } = await createApp({
      llm: new FakeLlm({ objects: [] }),
      storage,
      authz: createHmacAuthzPort("test-secret"),
    });

    const { json } = await composeJson(app, QUARTERLY_GUI);
    expect(json.spec.provenance.tier).toBe("L0");
    expect(json.spec.provenance.fallback).toBeUndefined();
    expect(storage.events.some((e) => e.type === "view.fallback")).toBe(false);
    // view.composed is recorded (the normal path, not a demotion)
    expect(storage.events.some((e) => e.type === "view.composed")).toBe(true);
  });
});
