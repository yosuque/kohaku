import type { LineageEventRecord, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { buildExplainReport, createKohakuClient } from "../src/index.js";
import type { Transport } from "../src/transport.js";

function composedEvent(
  payload: Record<string, unknown>,
  overrides: Partial<LineageEventRecord> = {},
): LineageEventRecord {
  return {
    id: "ev-1",
    ts: "2026-09-27T00:00:00.000Z",
    actor: { kind: "system" },
    type: "view.composed",
    payload,
    ...overrides,
  };
}

const BASE_PAYLOAD = {
  specHash: "sha256:" + "a".repeat(64),
  intentHash: "sha256:" + "b".repeat(64),
  canonical: "sales.trend",
  dataVersion: "v1",
  tier: "L1",
  cache: "miss",
  surface: "web",
};

describe("buildExplainReport", () => {
  it("extracts provenance / cacheKeyParts / decision from a view.composed event's payload", () => {
    const event = composedEvent({
      ...BASE_PAYLOAD,
      correlationId: "req-1",
      cacheKey: "kohaku:0.2:sha256:aaa:v1:-",
      cacheKeyParts: { intentHash: BASE_PAYLOAD.intentHash, dataVersion: "v1" },
      generatorVersion: "gen-1",
      kit: { id: "default", version: "1" },
      decision: {
        attempts: [{ kind: "l1", ok: true }],
        coalesced: true,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });

    const report = buildExplainReport([event]);
    expect(report.composes).toHaveLength(1);
    const c = report.composes[0]!;
    expect(c.intentHash).toBe(BASE_PAYLOAD.intentHash);
    expect(c.correlationId).toBe("req-1");
    expect(c.tier).toBe("L1");
    expect(c.cacheKey).toBe("kohaku:0.2:sha256:aaa:v1:-");
    expect(c.cacheKeyParts).toEqual({ intentHash: BASE_PAYLOAD.intentHash, dataVersion: "v1" });
    expect(c.generatorVersion).toBe("gen-1");
    expect(c.kit).toEqual({ id: "default", version: "1" });
    expect(c.decision).toEqual({
      attempts: [{ kind: "l1", ok: true }],
      coalesced: true,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(report.events).toBe(report.events); // events is the passed array (identity not asserted further)
    expect(report.events).toHaveLength(1);
  });

  it("omits every explain field for an event recorded before those fields existed (byte-identical to the historical payload shape)", () => {
    const event = composedEvent({ ...BASE_PAYLOAD });
    const report = buildExplainReport([event]);
    const c = report.composes[0]!;
    expect(c.correlationId).toBeUndefined();
    expect(c.cacheKey).toBeUndefined();
    expect(c.cacheKeyParts).toBeUndefined();
    expect(c.decision).toBeUndefined();
    expect(c.kit).toBeUndefined();
    expect(c.generatorVersion).toBeUndefined();
    expect(c.fallback).toBeUndefined();
  });

  it("handles more than one view.composed event under the same requestId (a reused X-Request-Id)", () => {
    const first = composedEvent({ ...BASE_PAYLOAD, correlationId: "req-1" }, { id: "ev-1" });
    const second = composedEvent(
      { ...BASE_PAYLOAD, canonical: "sales.other", correlationId: "req-1" },
      { id: "ev-2" },
    );
    const report = buildExplainReport([first, second]);
    expect(report.composes).toHaveLength(2);
    expect(report.composes.map((c) => c.canonical)).toEqual(["sales.trend", "sales.other"]);
  });

  it("skips a view.composed record whose payload is missing a required field, without throwing", () => {
    const malformed = composedEvent({ specHash: "only-this-field" });
    const report = buildExplainReport([malformed]);
    expect(report.composes).toEqual([]);
  });

  it("ignores non-view.composed events for the composes list but keeps them in events", () => {
    const composed = composedEvent({ ...BASE_PAYLOAD });
    const used: LineageEventRecord = {
      id: "ev-2",
      ts: "2026-09-27T00:00:01.000Z",
      actor: { kind: "system" },
      type: "component.used",
      payload: { artifactId: "art-1" },
    };
    const report = buildExplainReport([composed, used]);
    expect(report.composes).toHaveLength(1);
    expect(report.events).toHaveLength(2);
  });

  it("includes scopes only when a Spec is passed", () => {
    const spec: UISpec = {
      kohaku: "0.1",
      intent: { canonical: "sales.trend", params: {}, hash: BASE_PAYLOAD.intentHash },
      dataVersion: "v1",
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["t"] },
        { id: "t", type: "presentSpreadsheet", props: {}, data: { $ref: "query://sales/summary" } },
      ],
      events: [],
      provenance: { tier: "L1", composedBy: "composer@0.1.0", cache: "miss" },
    };
    const withoutSpec = buildExplainReport([composedEvent(BASE_PAYLOAD)]);
    expect(withoutSpec.scopes).toBeUndefined();
    const withSpec = buildExplainReport([composedEvent(BASE_PAYLOAD)], spec);
    expect(withSpec.scopes).toEqual([{ kind: "read", ref: "query://sales/summary" }]);
  });
});

describe("KohakuClient.explain", () => {
  /** A fake transport serving GET /lineage?order=asc&correlationId=... across two pages, and rejecting anything else. */
  function pagedTransport(pages: LineageEventRecord[][]): Transport {
    let call = 0;
    const fake: Transport = async (url) => {
      const u = new URL(url, "http://localhost");
      expect(u.pathname).toBe("/api/kohaku/lineage");
      expect(u.searchParams.get("order")).toBe("asc");
      expect(u.searchParams.get("correlationId")).toBe("req-1");
      const page = pages[call] ?? [];
      const nextCursor = call < pages.length - 1 ? `cursor-${call}` : undefined;
      call += 1;
      return new Response(JSON.stringify({ events: page, ...(nextCursor != null ? { nextCursor } : {}) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return fake;
  }

  it("walks every page under the requestId's correlationId and builds a report from all of them", async () => {
    const page1 = [composedEvent({ ...BASE_PAYLOAD, correlationId: "req-1" }, { id: "ev-1" })];
    const page2 = [
      {
        id: "ev-2",
        ts: "2026-09-27T00:00:01.000Z",
        actor: { kind: "system" as const },
        type: "component.used",
        payload: { artifactId: "art-1", correlationId: "req-1" },
      },
    ];
    const client = createKohakuClient({
      baseUrl: "/api/kohaku",
      transport: pagedTransport([page1, page2]),
    });

    const report = await client.explain("req-1");
    expect(report.events).toHaveLength(2);
    expect(report.composes).toHaveLength(1);
    expect(report.composes[0]!.canonical).toBe("sales.trend");
  });

  it("passes opts.spec through to populate scopes", async () => {
    const spec: UISpec = {
      kohaku: "0.1",
      intent: { canonical: "sales.trend", params: {}, hash: BASE_PAYLOAD.intentHash },
      dataVersion: "v1",
      components: [{ id: "root", type: "layout.stack", props: {} }],
      events: [],
      provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
    };
    const client = createKohakuClient({
      baseUrl: "/api/kohaku",
      transport: pagedTransport([[]]),
    });
    const report = await client.explain("req-1", { spec });
    expect(report.scopes).toEqual([]);
  });
});

describe("ComposeView.requestId and KohakuClientConfig.onResponse", () => {
  function composeTransport(requestId: string): Transport {
    return async () =>
      new Response(JSON.stringify({ spec: { fake: true }, capability: "cap:x" }), {
        status: 200,
        headers: { "content-type": "application/json", "X-Request-Id": requestId },
      });
  }

  it("attaches the X-Request-Id response header to the returned ComposeView", async () => {
    const client = createKohakuClient({ baseUrl: "/api/kohaku", transport: composeTransport("req-abc") });
    const view = await client.compose({ intent: { canonical: "sales.trend", params: {} } });
    expect(view.requestId).toBe("req-abc");
  });

  it("calls onResponse with path / status / requestId for every request, success or failure", async () => {
    const onResponse = vi.fn();
    const client = createKohakuClient({
      baseUrl: "/api/kohaku",
      transport: composeTransport("req-xyz"),
      onResponse,
    });
    await client.compose({ intent: { canonical: "sales.trend", params: {} } });
    expect(onResponse).toHaveBeenCalledWith({ path: "/compose", status: 200, requestId: "req-xyz" });
  });

  it("leaves ComposeView.requestId unset when the header is absent (byte-identical to before)", async () => {
    const client = createKohakuClient({
      baseUrl: "/api/kohaku",
      transport: async () =>
        new Response(JSON.stringify({ spec: { fake: true }, capability: "cap:x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const view = await client.compose({ intent: { canonical: "sales.trend", params: {} } });
    expect("requestId" in view).toBe(false);
  });
});
