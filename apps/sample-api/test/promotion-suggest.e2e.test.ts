import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { createSchemaExtractor } from "@kohaku-ui/evals";
import type { GenerateObjectRequest } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { UISpec } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import type { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
afterEach(() => {
  vi.restoreAllMocks();
});
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const L2_HTML =
  "<!DOCTYPE html><html><head><title>Sales calendar heatmap</title></head><body><div id=hm></div><script>window.kohaku.fetchData('query://sales/trend?fy=2026&granularity=month&metric=revenue').then(function(d){document.getElementById('hm').textContent=d.rows.length+' months';window.kohaku.ready();});</script></body></html>";

const SUGGESTION_OUTPUT = {
  componentType: "sales.calendarHeatmap",
  intentName: "sales.calendar_heatmap",
  description: "Display sales as a monthly calendar heatmap",
  paramsJsonSchema: { type: "object", properties: { fiscalYear: { type: "integer", default: 2026 } } },
  queryTemplate: {
    path: "trend",
    fixedParams: { metric: "revenue", granularity: "month" },
    paramMap: { fiscalYear: "fy" },
  },
  events: [],
  confidence: 0.9,
};

const JUDGE_OUTPUT = {
  criteria: [
    { id: "safety", score: 0.9, reasoning: "uses kohaku API only" },
    { id: "determinism", score: 0.8, reasoning: "no randomness" },
    { id: "a11y", score: 0.7, reasoning: "has text" },
    { id: "schema_inferability", score: 0.8, reasoning: "parameterizable" },
    { id: "generality", score: 0.8, reasoning: "general-purpose" },
    { id: "visual_quality", score: 0.8, reasoning: "clean" },
    { id: "suggestion_fidelity", score: 0.9, reasoning: "matches the fetched ref" },
  ],
  summary: "worthy of promotion",
};

/** Dispatches by schemaName so the call order (NL / extraction / judge) does not matter. */
function scriptedLlm(
  overrides: { extraction?: (req: GenerateObjectRequest<unknown>) => unknown } = {},
): FakeLlm {
  return new FakeLlm({
    objects: (req) => {
      if (req.schemaName === "schema_suggestion")
        return (overrides.extraction ?? (() => SUGGESTION_OUTPUT))(req);
      if (req.schemaName === "judge_verdict") return JUDGE_OUTPUT;
      return { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } };
    },
    texts: () => L2_HTML,
  });
}

async function ask(app: Hono, text: string, sessionId: string): Promise<UISpec> {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { kind: "nl", text }, session: { surface: "chat", sessionId } }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { spec: UISpec }).spec;
}

async function nominateHeatmap(app: Hono) {
  await ask(app, "Sales as a calendar heatmap", "s1");
  await ask(app, "Sales as a calendar heatmap", "s2");
  const res = await app.request("/api/kohaku/promotions/evaluate", { method: "POST" });
  const { candidates } = (await res.json()) as {
    candidates: {
      artifactId: string;
      status: string;
      suggestion?: { draft: Record<string, unknown>; model: string; extractorId: string };
    }[];
  };
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}

describe("promotion schema suggestion E2E (the calendar heatmap is approvable without editing the prefill)", () => {
  it("evaluate attaches a suggestion, approving it unchanged publishes and records a zero-edit schemaEdited", async () => {
    const llm = scriptedLlm();
    const storage = createFileStoragePort(tmpDir("kohaku-suggest-"));
    const { app } = await createApp({
      llm,
      storage,
      authz: createHmacAuthzPort("test-secret"),
      schemaExtractor: createSchemaExtractor({ llm }),
    });

    const candidate = await nominateHeatmap(app);
    expect(candidate.status).toBe("candidate");
    expect(candidate.suggestion?.extractorId).toBe("l2-schema-extraction");
    expect(candidate.suggestion?.draft).toEqual({
      ...SUGGESTION_OUTPUT,
      version: "1.0.0",
      events: undefined,
      confidence: undefined,
    });
    // The extractor saw the fetched ref and the product's query paths
    const extraction = llm.calls.find((c) => c.schemaName === "schema_suggestion")!;
    expect(extraction.prompt).toContain("query://sales/trend?fy=2026&granularity=month&metric=revenue");
    expect(extraction.prompt).toContain("summary, trend, records, kpi, targets");

    // Approve with the suggested draft verbatim (what the UI sends when the reviewer edits nothing) and
    // acknowledges the suggestion (acceptedAsIs, below, requires both an empty diff and acknowledgement).
    const approveRes = await app.request(`/api/kohaku/promotions/${candidate.artifactId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: candidate.suggestion!.draft, acknowledgedSuggestion: true }),
    });
    expect(approveRes.status).toBe(200);
    expect(((await approveRes.json()) as { candidate: { status: string } }).candidate.status).toBe(
      "published",
    );
    // The judge received the suggestion as evidence
    const judgeCall = llm.calls.find((c) => c.schemaName === "judge_verdict")!;
    expect(judgeCall.prompt).toContain("## Proposed schema");

    const { events } = (await (
      await app.request(`/api/kohaku/lineage?artifactId=${candidate.artifactId}&limit=50`)
    ).json()) as {
      events: { type: string; actor: { kind: string }; payload: Record<string, unknown> }[];
    };
    const types = events.map((e) => e.type);
    expect(types.indexOf("component.schemaSuggested")).toBeGreaterThan(types.indexOf("component.nominated"));
    expect(types.indexOf("component.schemaEdited")).toBeGreaterThan(types.indexOf("component.reviewed"));
    const edited = events.find((e) => e.type === "component.schemaEdited")!;
    expect(edited.actor.kind).toBe("user");
    expect(edited.payload["changed"]).toEqual([]);

    const { summary } = (await (await app.request("/api/kohaku/analytics/summary")).json()) as {
      summary: {
        promotions: { schemaSuggested: number; schemaEdited: number };
        review: { count: number; acceptedAsIs: number; durationMs: { p50: number | null } };
      };
    };
    expect(summary.promotions.schemaSuggested).toBe(1);
    expect(summary.promotions.schemaEdited).toBe(1);
    expect(summary.review.count).toBe(1);
    expect(summary.review.acceptedAsIs).toBe(1);
    expect(summary.review.durationMs.p50).not.toBeNull();
  });

  it("fails open: an extraction failure reaches the observability hook and the candidate still surfaces (empty form)", async () => {
    const llm = scriptedLlm({
      extraction: () => {
        throw new Error("extractor down");
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createFileStoragePort(tmpDir("kohaku-suggest-fail-"));
    const { app } = await createApp({
      llm,
      storage,
      authz: createHmacAuthzPort("test-secret"),
      schemaExtractor: createSchemaExtractor({ llm }),
    });
    const candidate = await nominateHeatmap(app);
    expect(candidate.status).toBe("candidate");
    expect(candidate.suggestion).toBeUndefined();
    expect(errors.mock.calls.some((args) => String(args[0]).includes("promotion.suggest.schema"))).toBe(true);
  });

  it("without an extractor (the test default) nothing is attached and no extraction call is made", async () => {
    const llm = scriptedLlm();
    const storage = createFileStoragePort(tmpDir("kohaku-suggest-off-"));
    const { app } = await createApp({ llm, storage, authz: createHmacAuthzPort("test-secret") });
    const candidate = await nominateHeatmap(app);
    expect(candidate.suggestion).toBeUndefined();
    expect(llm.calls.some((c) => c.schemaName === "schema_suggestion")).toBe(false);
  });
});
