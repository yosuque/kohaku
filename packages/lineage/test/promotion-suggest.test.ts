import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  type ComponentDraft,
  createLineage,
  createPromotions,
  type PromotionCandidate,
  type PromotionErrorContext,
  type SchemaSuggestion,
  type TenantScope,
} from "../src/index.js";

function memoryStorage(): StoragePort & {
  events: LineageEventRecord[];
  states: Map<string, PromotionState>;
} {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const key = (id: string, tenant?: string) => `${tenant ?? ""}::${id}`;
  return {
    events,
    states,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
      events.push(event);
    },
    async listLineage(filter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      if (filter.artifactId != null)
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
      return result.slice(-(filter.limit ?? 200));
    },
    async getPromotionState(id, tenant) {
      return states.get(key(id, tenant)) ?? null;
    },
    async putPromotionState(state) {
      states.set(key(state.artifactId, state.tenant), state);
    },
    async listPromotionStates(tenant) {
      const all = [...states.values()];
      return tenant != null ? all.filter((s) => s.tenant === tenant) : all;
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

function seedUsage(storage: ReturnType<typeof memoryStorage>, artifactId: string, uses: number): void {
  storage.events.push({
    id: `g-${artifactId}`,
    ts: "2026-07-01T00:00:00.000Z",
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: "<html><body>hm</body></html>", request: "Sales as a calendar heatmap" },
  });
  for (let i = 0; i < uses; i++) {
    storage.events.push({
      id: `u-${artifactId}-${i}`,
      ts: `2026-07-01T00:0${i}:00.000Z`,
      actor: { kind: "system" },
      type: "component.used",
      payload: { artifactId, surface: "chat", sessionId: `s${i}`, outcome: "ok" },
    });
  }
}

const DRAFT: ComponentDraft = {
  componentType: "sales.calendarHeatmap",
  version: "1.0.0",
  intentName: "sales.calendar_heatmap",
  description: "Display sales as a monthly calendar heatmap",
};

const SUGGESTION: SchemaSuggestion = {
  draft: DRAFT,
  events: [],
  confidence: 0.9,
  model: "fake-model",
  extractorId: "l2-schema-extraction",
  extractorVersion: "0.1",
  suggestedAt: "2026-07-01T00:10:00.000Z",
};

function pipeline(
  storage: ReturnType<typeof memoryStorage>,
  suggest:
    | ((candidate: PromotionCandidate, context?: TenantScope) => Promise<SchemaSuggestion | null>)
    | undefined,
) {
  const errors: { ctx: PromotionErrorContext; error: unknown }[] = [];
  const promotions = createPromotions({
    lineage: createLineage({ storage }),
    storage,
    policy: { minUses: 2, minDistinctSessions: 1, judgeBlocking: false },
    ...(suggest != null ? { suggestSchema: suggest } : {}),
    onError: (ctx, error) => errors.push({ ctx, error }),
  });
  return { promotions, errors };
}

describe("schema suggestion at nomination (advisory, fail-open)", () => {
  it("calls suggestSchema for each newly nominated candidate, persists it and records component.schemaSuggested", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const suggest = vi.fn(async (_candidate: PromotionCandidate) => SUGGESTION);
    const { promotions, errors } = pipeline(storage, suggest);

    const listed = await promotions.evaluateAndList();
    expect(listed[0]!.status).toBe("candidate");
    expect(listed[0]!.suggestion).toEqual(SUGGESTION);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]![0]!.artifactId).toBe("a1");
    // Persisted on the snapshot, and reloaded by a read-only list
    expect(storage.states.get("::a1")!.data["suggestion"]).toEqual(SUGGESTION);
    expect((await promotions.list())[0]!.suggestion).toEqual(SUGGESTION);
    // Audit: model actor, after component.nominated
    const types = storage.events.map((e) => e.type);
    expect(types.indexOf("component.schemaSuggested")).toBeGreaterThan(types.indexOf("component.nominated"));
    const suggested = storage.events.find((e) => e.type === "component.schemaSuggested")!;
    expect(suggested.actor).toEqual({ kind: "model" });
    expect(suggested.payload).toEqual({ artifactId: "a1", suggestion: SUGGESTION });
    expect(errors).toEqual([]);
  });

  it("does not call suggestSchema again for an already-nominated candidate", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const suggest = vi.fn(async () => SUGGESTION);
    const { promotions } = pipeline(storage, suggest);
    await promotions.evaluateAndList();
    await promotions.evaluateAndList();
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it("fails open: a throwing suggestSchema leaves the candidate nominated without a suggestion and reports promotion.suggest.schema", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const { promotions, errors } = pipeline(storage, async () => {
      throw new Error("llm down");
    });
    const listed = await promotions.evaluateAndList();
    expect(listed[0]!.status).toBe("candidate");
    expect(listed[0]!.suggestion).toBeUndefined();
    expect(storage.states.get("::a1")!.data).not.toHaveProperty("suggestion");
    expect(storage.events.map((e) => e.type)).not.toContain("component.schemaSuggested");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.ctx).toEqual({ endpoint: "promotion.suggest.schema", artifactId: "a1" });
  });

  it("runs extractions concurrently across a scan: one throwing candidate does not affect the other", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    seedUsage(storage, "a2", 2);
    const suggest = vi.fn(async (candidate: PromotionCandidate) => {
      if (candidate.artifactId === "a1") throw new Error("llm down");
      return SUGGESTION;
    });
    const { promotions, errors } = pipeline(storage, suggest);

    const listed = await promotions.evaluateAndList();
    expect(listed).toHaveLength(2);
    expect(listed.every((c) => c.status === "candidate")).toBe(true);
    const a1 = listed.find((c) => c.artifactId === "a1")!;
    const a2 = listed.find((c) => c.artifactId === "a2")!;
    expect(a1.suggestion).toBeUndefined();
    expect(a2.suggestion).toEqual(SUGGESTION);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.ctx).toEqual({ endpoint: "promotion.suggest.schema", artifactId: "a1" });
    const types = storage.events.map((e) => e.type);
    expect(types.filter((t) => t === "component.nominated")).toHaveLength(2);
    expect(types.filter((t) => t === "component.schemaSuggested")).toHaveLength(1);
  });

  it("a null suggestion is 'no suggestion' (nothing persisted, nothing audited, no error)", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const { promotions, errors } = pipeline(storage, async () => null);
    const listed = await promotions.evaluateAndList();
    expect(listed[0]!.suggestion).toBeUndefined();
    expect(storage.events.map((e) => e.type)).not.toContain("component.schemaSuggested");
    expect(errors).toEqual([]);
  });

  it("without the hook nothing changes (the persisted key set is the pre-existing one)", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const { promotions } = pipeline(storage, undefined);
    await promotions.evaluateAndList();
    expect(Object.keys(storage.states.get("::a1")!.data)).toEqual(["request"]);
  });
});

describe("component.schemaEdited on approve", () => {
  it("records the field diff between the suggestion and the submitted draft (zero edits -> changed: [])", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const { promotions } = pipeline(storage, async () => SUGGESTION);
    await promotions.evaluateAndList();
    const reviewer = { id: "alice" };
    const published = await promotions.approve("a1", { ...DRAFT }, reviewer);
    expect(published.status).toBe("published");
    const edited = storage.events.find((e) => e.type === "component.schemaEdited")!;
    expect(edited.actor).toEqual({ kind: "user", id: "alice" });
    expect(edited.payload).toEqual({
      artifactId: "a1",
      reviewer: "alice",
      extractorId: "l2-schema-extraction",
      extractorVersion: "0.1",
      changed: [],
      unchanged: [
        "componentType",
        "version",
        "intentName",
        "description",
        "paramsJsonSchema",
        "queryTemplate",
      ],
    });
    const types = storage.events.map((e) => e.type);
    // The edit record sits between the human approve (component.reviewed) and publish, next to schemaProposed
    expect(types.indexOf("component.schemaEdited")).toBeGreaterThan(types.indexOf("component.reviewed"));
    expect(types.indexOf("component.schemaEdited")).toBeLessThan(types.indexOf("component.published"));
  });

  it("records the edited fields with old and new values", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const { promotions } = pipeline(storage, async () => SUGGESTION);
    await promotions.evaluateAndList();
    await promotions.approve("a1", { ...DRAFT, description: "Monthly sales heatmap" }, { id: "alice" });
    const edited = storage.events.find((e) => e.type === "component.schemaEdited")!;
    expect(edited.payload["changed"]).toEqual([
      { field: "description", suggested: DRAFT.description, final: "Monthly sales heatmap" },
    ]);
  });

  it("does not block approve/publish when a persisted suggestion is malformed (missing draft)", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const { promotions, errors } = pipeline(storage, async () => SUGGESTION);
    await promotions.evaluateAndList();
    // Simulate a truncated write / hand-edited promotions.json: `data.suggestion` exists but lacks `draft`.
    // candidate-store casts this straight to SchemaSuggestion with no validation.
    const state = storage.states.get("::a1")!;
    storage.states.set("::a1", { ...state, data: { ...state.data, suggestion: { extractorId: "x" } } });
    const published = await promotions.approve("a1", { ...DRAFT }, { id: "alice" });
    expect(published.status).toBe("published");
    expect(storage.events.map((e) => e.type)).not.toContain("component.schemaEdited");
    expect(errors.some((e) => e.ctx.endpoint === "promotion.approve.audit")).toBe(true);
  });

  it("records nothing when the candidate has no suggestion", async () => {
    const storage = memoryStorage();
    seedUsage(storage, "a1", 2);
    const { promotions } = pipeline(storage, undefined);
    await promotions.evaluateAndList();
    await promotions.approve("a1", DRAFT, { id: "alice" });
    expect(storage.events.map((e) => e.type)).not.toContain("component.schemaEdited");
  });
});
