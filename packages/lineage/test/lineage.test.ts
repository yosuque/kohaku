import {
  computeSpecHash,
  type FixationRecord,
  type LineageEventRecord,
  type Principal,
  type PromotionState,
  type StoragePort,
  sha256Hex,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  artifactIdOf,
  type ComponentDraft,
  createFixations,
  createLineage,
  createPromotions,
  createViewRecorder,
  PromotionNotPublishedError,
  PromotionNotRejectedError,
  TransitionError,
} from "../src/index.js";

function memoryStorage(): StoragePort & { events: LineageEventRecord[] } {
  const events: LineageEventRecord[] = [];
  return {
    events,
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
      // tenant (3-6) filter. Unset means all (legacy behavior).
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      if (filter.artifactId != null)
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
      if (filter.specHash != null) result = result.filter((e) => e.payload["specHash"] === filter.specHash);
      if (filter.intentHash != null)
        result = result.filter((e) => e.payload["intentHash"] === filter.intentHash);
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

async function l2Spec(): Promise<UISpec> {
  const html = "<html><body><script>window.kohaku.ready()</script></body></html>";
  return {
    kohaku: "0.1",
    intent: {
      canonical: "sales.custom",
      params: { request: "ヒートマップで" },
      hash: "sha256:" + "1".repeat(64),
    },
    dataVersion: "sales@seed-1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["sandbox1"] },
      {
        id: "sandbox1",
        type: "sandbox.html",
        props: {},
        artifact: { inline: html, sha256: await sha256Hex(html) },
        data: { $ref: "query://sales/trend?metric=revenue" },
      },
    ],
    events: [],
    provenance: { tier: "L2", composedBy: "composer@0.1.0", model: "test-model", cache: "miss" },
  };
}

const trace = {
  intent: { canonical: "sales.custom", hash: "sha256:" + "1".repeat(64) },
  dataVersion: "sales@seed-1",
  cache: "miss",
  tier: "L2" as const,
  durationMs: 10,
};

describe("lineage 記録系", () => {
  it("L2 の viewComposed は component.generated / component.used を自動記録する", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec();

    await lineage.viewComposed({ spec, trace, surface: "chat", sessionId: "s1" });
    expect(storage.events.map((e) => e.type)).toEqual([
      "view.composed",
      "component.generated",
      "component.used",
    ]);

    const generated = storage.events[1]!;
    const artifactId = artifactIdOf(spec.components[1]!.artifact!.sha256);
    expect(generated.payload["artifactId"]).toBe(artifactId);
    expect(generated.payload["request"]).toBe("ヒートマップで");
    // The material for re-mounting the preview (the artifact body + the data reference at generation time) is also kept
    expect(generated.payload["html"]).toBe(spec.components[1]!.artifact!.inline);
    expect(generated.payload["ref"]).toBe("query://sales/trend?metric=revenue");
    expect(generated.actor.kind).toBe("model");

    // On the 2nd time (cache hit), generated is not duplicated and only used increases
    await lineage.viewComposed({
      spec: { ...spec, provenance: { ...spec.provenance, cache: "hit" } },
      trace: { ...trace, cache: "hit" },
      surface: "web",
    });
    const types = storage.events.map((e) => e.type);
    expect(types.filter((t) => t === "component.generated")).toHaveLength(1);
    expect(types.filter((t) => t === "component.used")).toHaveLength(2);

    // Provenance query
    const history = await lineage.history(artifactId);
    expect(history.map((e) => e.type)).toEqual(["component.generated", "component.used", "component.used"]);
  });

  it("L0/L1 の viewComposed は view.composed のみ", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec();
    const l1: UISpec = {
      ...spec,
      components: [{ id: "root", type: "layout.stack", props: {} }],
      provenance: { tier: "L1", composedBy: "composer@0.1.0", cache: "miss" },
    };
    await lineage.viewComposed({ spec: l1, trace: { ...trace, tier: "L1" }, surface: "web" });
    expect(storage.events.map((e) => e.type)).toEqual(["view.composed"]);
    expect(storage.events[0]!.payload["tier"]).toBe("L1");
  });

  it("explainView は specHash で View の連鎖を辿れる", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec();
    await lineage.viewComposed({ spec, trace, surface: "chat" });
    const specHash = await computeSpecHash(spec);
    const explain = await lineage.explainView(specHash);
    expect(explain.length).toBeGreaterThanOrEqual(2); // composed + generated
  });

  it("事前計算済みハッシュを渡すと再計算せず記録に使う(#9 の 1 回計算共有)", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec();
    // Pass a sentinel value different from the real hash (if the passed value lands in the record, that is proof it did not recompute).
    const fakeSpecHash = "sha256:" + "f".repeat(64);
    const fakeStructureHash = "sha256:" + "e".repeat(64);
    expect(fakeSpecHash).not.toBe(await computeSpecHash(spec));

    await lineage.viewComposed({
      spec,
      trace,
      surface: "web",
      specHash: fakeSpecHash,
      structureHash: fakeStructureHash,
    });

    const composed = storage.events.find((e) => e.type === "view.composed")!;
    expect(composed.payload["specHash"]).toBe(fakeSpecHash);
    expect(composed.payload["structureHash"]).toBe(fakeStructureHash);
    // component.generated (L2) also inherits the same specHash (sharing the single computation).
    const generated = storage.events.find((e) => e.type === "component.generated")!;
    expect(generated.payload["specHash"]).toBe(fakeSpecHash);
  });

  it("ハッシュ未指定なら従来どおり内部計算する(後方互換)", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec();

    await lineage.viewComposed({ spec, trace, surface: "web" });

    const composed = storage.events.find((e) => e.type === "view.composed")!;
    // If not passed, the Spec's real hash is recorded.
    expect(composed.payload["specHash"]).toBe(await computeSpecHash(spec));
  });

  it("component.generated の重複判定は recorder 内 Set で二度目以降 storage を照会しない(3-12a)", async () => {
    const storage = memoryStorage();
    // Count the number of component.generated lookups (verifies that the Set skips dedup's O(n) full scan).
    let generatedLookups = 0;
    const origList = storage.listLineage;
    storage.listLineage = (filter) => {
      if (filter?.type?.includes("component.generated")) generatedLookups++;
      return origList(filter);
    };
    const lineage = createLineage({ storage });
    const spec = await l2Spec(); // provenance.cache === "miss"

    // 1st time (miss): looks up storage and records generated.
    await lineage.viewComposed({ spec, trace, surface: "web" });
    expect(generatedLookups).toBe(1);
    // 2nd time (miss, same artifactId): a Set hit means listLineage is not called.
    await lineage.viewComposed({ spec, trace, surface: "web" });
    expect(generatedLookups).toBe(1);
    // Correctness is invariant: generated exactly once, used twice.
    expect(storage.events.filter((e) => e.type === "component.generated")).toHaveLength(1);
    expect(storage.events.filter((e) => e.type === "component.used")).toHaveLength(2);
  });
});

describe("view.fallback の記録(RestViewRecorder)", () => {
  function negotiatedSpec(): UISpec {
    return {
      kohaku: "0.1",
      intent: {
        canonical: "sales.custom",
        params: { request: "ヒートマップで" },
        hash: "sha256:" + "a".repeat(64),
      },
      dataVersion: "sales@seed-1",
      components: [{ id: "root", type: "layout.stack", props: {} }],
      events: [],
      provenance: {
        tier: "L2",
        composedBy: "composer@0.1.0",
        cache: "hit",
        fallback: {
          from: "sandbox1:sandbox.html",
          reason: "capability negotiation",
          kind: "negotiation",
        },
      },
    };
  }

  it("negotiate 降格(kind:negotiation)を specHash / intentHash 付きで記録する", async () => {
    const storage = memoryStorage();
    const recorder = createViewRecorder(createLineage({ storage }));
    const spec = negotiatedSpec();

    await recorder.fallback!({
      spec,
      reason: spec.provenance.fallback!.reason,
      kind: "negotiation",
      surface: "web",
      sessionId: "s1",
    });

    const fallbacks = storage.events.filter((e) => e.type === "view.fallback");
    expect(fallbacks).toHaveLength(1);
    const payload = fallbacks[0]!.payload;
    expect(payload["kind"]).toBe("negotiation");
    expect(payload["intentHash"]).toBe(spec.intent.hash);
    expect(payload["specHash"]).toBe(await computeSpecHash(spec));
    expect(payload["surface"]).toBe("web");
    expect(payload["sessionId"]).toBe("s1");
    expect(payload["reason"]).toBe("capability negotiation");
  });

  it("sessionId 省略時は payload に sessionId を刻まない", async () => {
    const storage = memoryStorage();
    const recorder = createViewRecorder(createLineage({ storage }));
    const spec = negotiatedSpec();

    await recorder.fallback!({
      spec,
      reason: spec.provenance.fallback!.reason,
      kind: "generation",
      surface: "chat",
    });

    const payload = storage.events.find((e) => e.type === "view.fallback")!.payload;
    expect(payload["kind"]).toBe("generation");
    expect("sessionId" in payload).toBe(false);
  });
});

function ev(type: string, payload: Record<string, unknown>): LineageEventRecord {
  return {
    id: `${type}:${JSON.stringify(payload)}`,
    ts: new Date().toISOString(),
    actor: { kind: "system" },
    type,
    payload,
  };
}

describe("昇格の評価(evaluateAndList)", () => {
  it("一覧取得を繰り返しても component.nominated を二重記録しない(冪等)", async () => {
    const storage = memoryStorage();
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 2, minDistinctSessions: 1, judgeBlocking: false },
    });
    // Pile up usage logs so that one component satisfies the threshold (uses>=2)
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", request: "r" }));
    await storage.appendLineage(ev("component.used", { artifactId: "a1", sessionId: "s1" }));
    await storage.appendLineage(ev("component.used", { artifactId: "a1", sessionId: "s2" }));

    const first = await promotions.evaluateAndList();
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe("candidate");

    // GET-style re-evaluation on the 2nd and later times. Since memoryStorage's putPromotionState is a no-op,
    // status stays in_use, but the nominated-event guard must keep it from being re-recorded.
    await promotions.evaluateAndList();
    await promotions.evaluateAndList();

    const nominated = storage.events.filter((e) => e.type === "component.nominated");
    expect(nominated).toHaveLength(1);
  });

  it("候補は component.generated の html / sha256 / ref を公開する(プレビューの材料)", async () => {
    const storage = memoryStorage();
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 2, minDistinctSessions: 1, judgeBlocking: false },
    });
    await storage.appendLineage(
      ev("component.generated", {
        artifactId: "a1",
        artifactSha256: "c".repeat(64),
        request: "r",
        html: "<html>preview</html>",
        ref: "query://sales/trend?metric=revenue",
      }),
    );
    await storage.appendLineage(ev("component.used", { artifactId: "a1", sessionId: "s1" }));

    const list = await promotions.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.html).toBe("<html>preview</html>");
    expect(list[0]!.sha256).toBe("c".repeat(64));
    expect(list[0]!.ref).toBe("query://sales/trend?metric=revenue");
  });

  it("source:'telemetry' の component.used は uses に数えない(compose 記録を正とする)", async () => {
    const storage = memoryStorage();
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 2, minDistinctSessions: 1, judgeBlocking: false },
    });
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", request: "r" }));
    // 2 compose-time records (no source) -> becomes a candidate at uses=2
    await storage.appendLineage(ev("component.used", { artifactId: "a1", sessionId: "s1" }));
    await storage.appendLineage(ev("component.used", { artifactId: "a1", sessionId: "s2" }));
    // Telemetry-path records (source:"telemetry") are actual-render observations, so excluded from aggregation
    await storage.appendLineage(
      ev("component.used", { artifactId: "a1", sessionId: "s3", source: "telemetry" }),
    );

    const list = await promotions.evaluateAndList();
    expect(list).toHaveLength(1);
    expect(list[0]!.uses).toBe(2);
    expect(list[0]!.sessions).toBe(2);
  });

  it("list() は読み取り専用(nominate しない)、evaluateAndList() は candidate 化して nominate を記録する", async () => {
    const storage = memoryStorage();
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 2, minDistinctSessions: 1, judgeBlocking: false },
    });
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", request: "r" }));
    await storage.appendLineage(ev("component.used", { artifactId: "a1", sessionId: "s1" }));
    await storage.appendLineage(ev("component.used", { artifactId: "a1", sessionId: "s2" }));

    // list returns the candidate but keeps it in_use (no nominate side effect).
    const listed = await promotions.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("in_use");
    expect(storage.events.some((e) => e.type === "component.nominated")).toBe(false);

    // evaluateAndList makes the threshold-satisfying one a candidate and records component.nominated.
    const evaluated = await promotions.evaluateAndList();
    expect(evaluated[0]!.status).toBe("candidate");
    expect(storage.events.filter((e) => e.type === "component.nominated")).toHaveLength(1);
  });
});

describe("昇格の承認(approve)", () => {
  const reviewer: Principal = { id: "admin" };
  const draft: ComponentDraft = {
    componentType: "sales.customX",
    version: "1.0.0",
    intentName: "sales.customX",
    description: "テスト用ドラフト",
  };

  /** A storage that actually persists promotion state (approve's staged transitions depend on state read-back). */
  function storageWithPromotionState(): StoragePort & { events: LineageEventRecord[] } {
    const base = memoryStorage();
    const states = new Map<string, PromotionState>();
    return {
      ...base,
      async getPromotionState(id) {
        return states.get(id) ?? null;
      },
      async putPromotionState(state) {
        states.set(state.artifactId, state);
      },
      async listPromotionStates() {
        return [...states.values()];
      },
    };
  }

  it("judgeBlocking:true + 不合格 judge で approve() は PromotionNotPublishedError を投げる", async () => {
    const storage = storageWithPromotionState();
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", html: "<html></html>" }));
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: true },
      judge: async () => ({ pass: false, score: 0.1 }),
    });

    const err = await promotions.approve("a1", draft, reviewer).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PromotionNotPublishedError);
    expect((err as PromotionNotPublishedError).code).toBe("PROMOTION_NOT_PUBLISHED");
    expect((err as PromotionNotPublishedError).status).toBe("judge_failed");
    // Not published, so no published event remains
    expect(storage.events.some((e) => e.type === "component.published")).toBe(false);
  });

  it("既 published への再 approve は throw せず published を冪等に返す", async () => {
    const storage = storageWithPromotionState();
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", html: "<html></html>" }));
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      // judge treated as advisory (judgeBlocking:false) to pass all the way to published
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });

    const first = await promotions.approve("a1", draft, reviewer);
    expect(first.status).toBe("published");
    // The 2nd time does not reach publish (already published) and enters no transition, so it returns published without throwing
    const second = await promotions.approve("a1", draft, reviewer);
    expect(second.status).toBe("published");
    expect(storage.events.filter((e) => e.type === "component.published")).toHaveLength(1);
  });

  it("judge が throw + judgeBlocking:true → fail-open せず judge_failed で PromotionNotPublishedError", async () => {
    const storage = storageWithPromotionState();
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", html: "<html></html>" }));
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: true },
      // The judge run raises an exception (LLM trouble). The old implementation swallowed it as verdict=pass:true and passed all the way to publish.
      judge: async () => {
        throw new Error("LLM down");
      },
    });

    const err = await promotions.approve("a1", draft, reviewer).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PromotionNotPublishedError);
    expect((err as PromotionNotPublishedError).status).toBe("judge_failed");
    // It did not fail-open, so no published event remains.
    expect(storage.events.some((e) => e.type === "component.published")).toBe(false);
    // The cannot-decide reason remains in the audit as the verdict (pass:false).
    const judged = storage.events.find((e) => e.type === "component.judged");
    const verdict = judged!.payload["verdict"] as { pass: boolean; reason?: string };
    expect(verdict.pass).toBe(false);
    expect(String(verdict.reason)).toContain("judge could not run");
  });

  it("judge が throw + judgeBlocking:false → 助言扱いで in_review 以降へ進み published に到達する", async () => {
    const storage = storageWithPromotionState();
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", html: "<html></html>" }));
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
      judge: async () => {
        throw new Error("LLM down");
      },
    });

    // Because judgeBlocking:false, even a judge that cannot run does not stop at judge_failed but, by policy delegation, goes in_review -> published.
    const result = await promotions.approve("a1", draft, reviewer);
    expect(result.status).toBe("published");
    expect(storage.events.filter((e) => e.type === "component.published")).toHaveLength(1);
  });
});

describe("レビュー・ワークフロー強化(B6-lite)", () => {
  const reviewer: Principal = { id: "admin" };
  const draft: ComponentDraft = {
    componentType: "sales.customX",
    version: "1.0.0",
    intentName: "sales.customX",
    description: "テスト用ドラフト",
  };

  /** A storage that persists promotion state key-separated by (tenant, artifactId) (listPromotionStates is also tenant-separated). */
  function storageWithStates(): StoragePort & { events: LineageEventRecord[] } {
    const base = memoryStorage();
    const states = new Map<string, PromotionState>();
    const key = (artifactId: string, tenant?: string) =>
      tenant != null && tenant !== "" ? `${tenant} ${artifactId}` : artifactId;
    return {
      ...base,
      async getPromotionState(artifactId, tenant) {
        return states.get(key(artifactId, tenant)) ?? null;
      },
      async putPromotionState(state) {
        states.set(key(state.artifactId, state.tenant), state);
      },
      async listPromotionStates(tenant) {
        const all = [...states.values()];
        return tenant == null ? all : all.filter((s) => s.tenant === tenant);
      },
    };
  }

  it("changes_requested から approve() は nominate 経由で復帰し published に到達する", async () => {
    const storage = storageWithStates();
    await storage.appendLineage(
      ev("component.generated", { artifactId: "a1", html: "<html></html>", request: "r" }),
    );
    // Directly seed the state sent back by review.requestChanges.
    await storage.putPromotionState({
      artifactId: "a1",
      status: "changes_requested",
      updatedAt: new Date().toISOString(),
      data: {},
    });
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      // judge treated as advisory (judgeBlocking:false, judge unset) to advance to in_review and beyond.
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });

    const result = await promotions.approve("a1", draft, reviewer);
    expect(result.status).toBe("published");
    // On recovery it returns to candidate, so nominate is recorded.
    expect(storage.events.filter((e) => e.type === "component.nominated")).toHaveLength(1);
    // LIN-PRM-001: the human review.approve precedes component.published (the structural guarantee is invariant).
    const reviewedIdx = storage.events.findIndex(
      (e) => e.type === "component.reviewed" && e.payload["decision"] === "approve",
    );
    const publishedIdx = storage.events.findIndex((e) => e.type === "component.published");
    expect(reviewedIdx).toBeGreaterThanOrEqual(0);
    expect(publishedIdx).toBeGreaterThan(reviewedIdx);
  });

  it("changes_requested → requestChanges → approve の往復でも published に復帰する(act 経由)", async () => {
    const storage = storageWithStates();
    await storage.appendLineage(
      ev("component.generated", { artifactId: "a1", html: "<html></html>", request: "r" }),
    );
    // Candidacy from in_use -> in_review -> drop to changes_requested via requestChanges (act's actual transition).
    await storage.putPromotionState({
      artifactId: "a1",
      status: "in_review",
      updatedAt: new Date().toISOString(),
      data: {},
    });
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });

    const changed = await promotions.act(
      "a1",
      { kind: "review.requestChanges", reviewer, comment: "修正して" },
      reviewer,
    );
    expect(changed.status).toBe("changes_requested");
    // After the send-back, fix and re-approve -> published.
    const result = await promotions.approve("a1", draft, reviewer);
    expect(result.status).toBe("published");
  });

  it("listByStatus は指定状態のみを返す(candidate 以降は listPromotionStates 索引)", async () => {
    const storage = storageWithStates();
    for (const [id, status] of [
      ["p1", "published"],
      ["c1", "candidate"],
      ["r1", "in_review"],
    ] as const) {
      await storage.appendLineage(ev("component.generated", { artifactId: id, request: "r" }));
      await storage.putPromotionState({
        artifactId: id,
        status,
        updatedAt: new Date().toISOString(),
        data: {},
      });
    }
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    expect((await promotions.listByStatus("published")).map((c) => c.artifactId)).toEqual(["p1"]);
    expect((await promotions.listByStatus("candidate")).map((c) => c.artifactId)).toEqual(["c1"]);
    expect((await promotions.listByStatus("in_review")).map((c) => c.artifactId)).toEqual(["r1"]);
    // No match is an empty array.
    expect(await promotions.listByStatus("rejected")).toEqual([]);
  });

  it("listByStatus('in_use') は永続状態を持たない artifact をイベントスキャンで返す(candidate は除外)", async () => {
    const storage = storageWithStates();
    // u1: state not saved (in_use = does not appear in listPromotionStates). c1: candidate state.
    await storage.appendLineage(ev("component.generated", { artifactId: "u1", request: "r" }));
    await storage.appendLineage(ev("component.generated", { artifactId: "c1", request: "r" }));
    await storage.putPromotionState({
      artifactId: "c1",
      status: "candidate",
      updatedAt: new Date().toISOString(),
      data: {},
    });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    // in_use is only u1 (narrowed from the same population as the legacy event-scan list).
    expect((await promotions.listByStatus("in_use")).map((c) => c.artifactId)).toEqual(["u1"]);
    // candidate is only c1 (u1's state is not saved, so it does not appear in the state index).
    expect((await promotions.listByStatus("candidate")).map((c) => c.artifactId)).toEqual(["c1"]);
  });

  it("listByStatus はテナントで分離する(未指定は全件 = 回帰)", async () => {
    const storage = storageWithStates();
    // acme's a1 (published) and globex's b1 (published).
    await storage.appendLineage(evT("component.generated", { artifactId: "a1", request: "r" }, "acme"));
    await storage.putPromotionState({
      artifactId: "a1",
      status: "published",
      updatedAt: new Date().toISOString(),
      data: {},
      tenant: "acme",
    });
    await storage.appendLineage(evT("component.generated", { artifactId: "b1", request: "r" }, "globex"));
    await storage.putPromotionState({
      artifactId: "b1",
      status: "published",
      updatedAt: new Date().toISOString(),
      data: {},
      tenant: "globex",
    });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    expect((await promotions.listByStatus("published", { tenant: "acme" })).map((c) => c.artifactId)).toEqual(
      ["a1"],
    );
    expect(
      (await promotions.listByStatus("published", { tenant: "globex" })).map((c) => c.artifactId),
    ).toEqual(["b1"]);
    // Unset means all tenants combined (the same regression behavior as the legacy list).
    expect((await promotions.listByStatus("published")).map((c) => c.artifactId).sort()).toEqual([
      "a1",
      "b1",
    ]);
  });
});

describe("昇格の却下(reject)", () => {
  const reviewer: Principal = { id: "admin" };

  function storageWithPromotionState(): StoragePort & { events: LineageEventRecord[] } {
    const base = memoryStorage();
    const states = new Map<string, PromotionState>();
    return {
      ...base,
      async getPromotionState(id) {
        return states.get(id) ?? null;
      },
      async putPromotionState(state) {
        states.set(state.artifactId, state);
      },
      async listPromotionStates() {
        return [...states.values()];
      },
    };
  }

  it("in_use → rejected の定型遷移(component.reviewed(decision:reject) を記録)", async () => {
    const storage = storageWithPromotionState();
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", request: "r" }));
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    const result = await promotions.reject("a1", reviewer);
    expect(result.status).toBe("rejected");
    const reviewed = storage.events.filter((e) => e.type === "component.reviewed");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.payload["decision"]).toBe("reject");
  });

  it("中間/終端状態(approved 等)からの reject はサイレント no-op せず PromotionNotRejectedError", async () => {
    const storage = storageWithPromotionState();
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", request: "r" }));
    // Directly seed a state that matches none of reject()'s if steps (in_use/candidate/in_review).
    await storage.putPromotionState({
      artifactId: "a1",
      status: "approved",
      updatedAt: new Date().toISOString(),
      data: {},
    });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    const err = await promotions.reject("a1", reviewer).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PromotionNotRejectedError);
    expect((err as PromotionNotRejectedError).code).toBe("PROMOTION_NOT_REJECTED");
    expect((err as PromotionNotRejectedError).status).toBe("approved");
    // Since it could not reject, component.reviewed(reject) is not recorded.
    expect(storage.events.some((e) => e.type === "component.reviewed")).toBe(false);
  });

  it("既 rejected への再 reject は throw せず rejected を冪等に返す(approve の既 published と対称)", async () => {
    const storage = storageWithPromotionState();
    await storage.appendLineage(ev("component.generated", { artifactId: "a1", request: "r" }));
    await storage.putPromotionState({
      artifactId: "a1",
      status: "rejected",
      updatedAt: new Date().toISOString(),
      data: {},
    });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    const result = await promotions.reject("a1", reviewer);
    expect(result.status).toBe("rejected");
  });
});

describe("昇格の取り下げ(unpublish / withdraw)", () => {
  const actor: Principal = { id: "admin" };
  const draft: ComponentDraft = {
    componentType: "sales.customX",
    version: "1.0.0",
    intentName: "sales.customX",
    description: "テスト用ドラフト",
  };

  function storageWithPromotionState(): StoragePort & { events: LineageEventRecord[] } {
    const base = memoryStorage();
    const states = new Map<string, PromotionState>();
    return {
      ...base,
      async getPromotionState(id) {
        return states.get(id) ?? null;
      },
      async putPromotionState(state) {
        states.set(state.artifactId, state);
      },
      async listPromotionStates() {
        return [...states.values()];
      },
    };
  }

  /** Directly seeds a promotion state with status and (optionally) draft. */
  async function seed(
    storage: StoragePort & { events: LineageEventRecord[] },
    artifactId: string,
    status: string,
    withDraft: boolean,
  ): Promise<void> {
    await storage.appendLineage(ev("component.generated", { artifactId, html: "<html></html>" }));
    await storage.putPromotionState({
      artifactId,
      status,
      updatedAt: new Date().toISOString(),
      data: withDraft ? { draft } : {},
    });
  }

  it("act(unpublish): published → withdrawn で onUnpublish 発火・component.withdrawn(from:published)・persist", async () => {
    const storage = storageWithPromotionState();
    await seed(storage, "a1", "published", true);
    const unpublished: { artifactId: string; draft: ComponentDraft }[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onUnpublish: async (args) => {
        unpublished.push(args);
      },
    });

    const result = await promotions.act("a1", { kind: "unpublish", reason: "陳腐化" }, actor);
    expect(result.status).toBe("withdrawn");
    // The side-effect hook is called with draft (used for catalog removal).
    expect(unpublished).toEqual([{ artifactId: "a1", draft }]);
    // Audit: from:"published" (distinguished from a pre-promotion withdraw), by:actor.id, reason, user actor.
    const withdrawn = storage.events.filter((e) => e.type === "component.withdrawn");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]!.payload["from"]).toBe("published");
    expect(withdrawn[0]!.payload["by"]).toBe("admin");
    expect(withdrawn[0]!.payload["reason"]).toBe("陳腐化");
    expect(withdrawn[0]!.actor).toEqual({ kind: "user", id: "admin" });
    // persist: the state has been updated to withdrawn.
    expect((await promotions.get("a1"))?.status).toBe("withdrawn");
  });

  it("withdraw() は published なら unpublish、candidate なら withdraw の定型遷移を選ぶ", async () => {
    // published -> unpublish (fires onUnpublish, from:published)
    const pubStorage = storageWithPromotionState();
    await seed(pubStorage, "p1", "published", true);
    let unpublishCalled = false;
    const pub = createPromotions({
      lineage: createLineage({ storage: pubStorage }),
      storage: pubStorage,
      onUnpublish: async () => {
        unpublishCalled = true;
      },
    });
    const pubResult = await pub.withdraw("p1", actor);
    expect(pubResult.status).toBe("withdrawn");
    expect(unpublishCalled).toBe(true);
    expect(pubStorage.events.find((e) => e.type === "component.withdrawn")!.payload["from"]).toBe(
      "published",
    );

    // candidate -> withdraw (onUnpublish is not called and no from is attached)
    const candStorage = storageWithPromotionState();
    await seed(candStorage, "c1", "candidate", false);
    let candUnpublishCalled = false;
    const cand = createPromotions({
      lineage: createLineage({ storage: candStorage }),
      storage: candStorage,
      onUnpublish: async () => {
        candUnpublishCalled = true;
      },
    });
    const candResult = await cand.withdraw("c1", actor);
    expect(candResult.status).toBe("withdrawn");
    expect(candUnpublishCalled).toBe(false);
    const candWithdrawn = candStorage.events.find((e) => e.type === "component.withdrawn")!;
    expect("from" in candWithdrawn.payload).toBe(false);
  });

  it("終端(rejected)への withdraw は TransitionError を伝播する(再取り下げを握り潰さない)", async () => {
    const storage = storageWithPromotionState();
    await seed(storage, "r1", "rejected", false);
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });
    await expect(promotions.withdraw("r1", actor)).rejects.toThrow(TransitionError);
  });
});

describe("固定化の解除(unfixate)", () => {
  const approver: Principal = { id: "admin" };

  async function makeRecord(): Promise<FixationRecord> {
    return {
      intentHash: "sha256:" + "2".repeat(64),
      canonical: "sales.trend",
      structureHash: "sha256:" + "3".repeat(64),
      pinnedSpec: await l2Spec(),
      fixatedAt: new Date().toISOString(),
      approver,
    };
  }

  it("deleteFixation 未実装の StoragePort では Fail Fast で弾く", async () => {
    const base = memoryStorage();
    const rec = await makeRecord();
    // getFixation returns the fixation but deleteFixation is not implemented (undefined)
    const storage: StoragePort & { events: LineageEventRecord[] } = {
      ...base,
      async getFixation() {
        return rec;
      },
    };
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await expect(fixations.unfixate(rec.intentHash, approver)).rejects.toThrow(/deleteFixation/);
    // Prevents the situation where the state cannot be removed yet only the audit remains (intent.unfixated is not recorded)
    expect(storage.events.some((e) => e.type === "intent.unfixated")).toBe(false);
  });

  it("deleteFixation 実装済みなら削除して intent.unfixated を記録する", async () => {
    const base = memoryStorage();
    const rec = await makeRecord();
    const fixed = new Map<string, FixationRecord>([[rec.intentHash, rec]]);
    const storage: StoragePort & { events: LineageEventRecord[] } = {
      ...base,
      async getFixation(h) {
        return fixed.get(h) ?? null;
      },
      async deleteFixation(h) {
        fixed.delete(h);
      },
    };
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await fixations.unfixate(rec.intentHash, approver);
    expect(fixed.has(rec.intentHash)).toBe(false);
    expect(storage.events.some((e) => e.type === "intent.unfixated")).toBe(true);
  });

  it("固定化が存在しなければ no-op(deleteFixation 未実装でも throw しない)", async () => {
    const storage = memoryStorage(); // getFixation always returns null
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await expect(fixations.unfixate("sha256:" + "9".repeat(64), approver)).resolves.toBeUndefined();
    expect(storage.events).toHaveLength(0);
  });
});

describe("固定化の陳腐化検出(2c-4)", () => {
  const approver: Principal = { id: "admin" };

  /** A storage that backs getFixation/putFixation/deleteFixation with real data (fixation requires read-back) */
  function storageWithFixations(seed?: FixationRecord): StoragePort & {
    events: LineageEventRecord[];
    fixed: Map<string, FixationRecord>;
  } {
    const base = memoryStorage();
    const fixed = new Map<string, FixationRecord>();
    if (seed != null) fixed.set(seed.intentHash, seed);
    return {
      ...base,
      fixed,
      async getFixation(h) {
        return fixed.get(h) ?? null;
      },
      async putFixation(rec) {
        fixed.set(rec.intentHash, rec);
      },
      async listFixations() {
        return [...fixed.values()];
      },
      async deleteFixation(h) {
        fixed.delete(h);
      },
    };
  }

  async function makeRecord(catalogFingerprint?: string): Promise<FixationRecord> {
    return {
      intentHash: "sha256:" + "2".repeat(64),
      canonical: "sales.trend",
      structureHash: "sha256:" + "3".repeat(64),
      pinnedSpec: await l2Spec(),
      fixatedAt: new Date().toISOString(),
      approver,
      ...(catalogFingerprint != null ? { catalogFingerprint } : {}),
    };
  }

  it("fixate は catalogFor 指定時に固定化時点のカタログ指紋を刻む", async () => {
    const storage = storageWithFixations();
    const fixations = createFixations({
      lineage: createLineage({ storage }),
      storage,
      catalogFor: () => ({ fingerprint: "fp-catalog-1" }),
    });

    const record = await fixations.fixate({ pinnedSpec: await l2Spec(), approver });
    expect(record.catalogFingerprint).toBe("fp-catalog-1");
    expect(storage.fixed.get(record.intentHash)?.catalogFingerprint).toBe("fp-catalog-1");
  });

  it("catalog 未指定なら指紋を刻まない(旧挙動 = 常に再検証)", async () => {
    const storage = storageWithFixations();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    const record = await fixations.fixate({ pinnedSpec: await l2Spec(), approver });
    expect("catalogFingerprint" in record).toBe(false);
  });

  it("invalidate は deleteFixation → intent.unfixated(system・reason:stale)の順で処理する", async () => {
    const rec = await makeRecord("fp-old");
    const storage = storageWithFixations(rec);
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await fixations.invalidate(rec.intentHash, "stale", { detail: "md1: type ... is not in the catalog" });

    // The state disappears first
    expect(storage.fixed.has(rec.intentHash)).toBe(false);
    // On success, the system-actor audit event (with reason / detail)
    const unfixated = storage.events.filter((e) => e.type === "intent.unfixated");
    expect(unfixated).toHaveLength(1);
    expect(unfixated[0]!.actor.kind).toBe("system");
    expect(unfixated[0]!.payload["reason"]).toBe("stale");
    expect(unfixated[0]!.payload["detail"]).toContain("catalog");
    // Since it is self-healing, approver is not stamped (distinguished from human-approved unfixate)
    expect("approver" in unfixated[0]!.payload).toBe(false);
  });

  it("invalidate は deleteFixation 未実装なら fail-fast(状態も監査も残さない)", async () => {
    const rec = await makeRecord("fp-old");
    const base = memoryStorage();
    const storage: StoragePort & { events: LineageEventRecord[] } = {
      ...base,
      async getFixation() {
        return rec;
      },
      // deleteFixation is not implemented
    };
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await expect(fixations.invalidate(rec.intentHash, "stale")).rejects.toThrow(/deleteFixation/);
    expect(storage.events.some((e) => e.type === "intent.unfixated")).toBe(false);
  });

  it("invalidate は固定化が無ければ no-op(deleteFixation 未実装でも throw しない)", async () => {
    const storage = memoryStorage(); // getFixation always returns null
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await expect(fixations.invalidate("sha256:" + "9".repeat(64), "stale")).resolves.toBeUndefined();
    expect(storage.events).toHaveLength(0);
  });

  it("refreshFingerprint は putFixation 上書きのみ(監査イベントは残さない)", async () => {
    const rec = await makeRecord("fp-old");
    const storage = storageWithFixations(rec);
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await fixations.refreshFingerprint(rec.intentHash, "fp-new");

    expect(storage.fixed.get(rec.intentHash)?.catalogFingerprint).toBe("fp-new");
    // Resolving staleness is not a governance decision, so no event is recorded
    expect(storage.events).toHaveLength(0);
  });

  it("refreshFingerprint は固定化が無ければ no-op", async () => {
    const storage = storageWithFixations();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await expect(fixations.refreshFingerprint("sha256:" + "9".repeat(64), "fp-new")).resolves.toBeUndefined();
    expect(storage.events).toHaveLength(0);
  });
});

/** Builds a lineage event stamped with tenant (for the 3-6 scoped-aggregation tests). */
function evT(type: string, payload: Record<string, unknown>, tenant?: string): LineageEventRecord {
  return {
    id: `${type}:${JSON.stringify(payload)}:${tenant ?? ""}`,
    ts: new Date().toISOString(),
    actor: { kind: "system" },
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

describe("テナントスコープ(3-6)", () => {
  it("record は tenant を LineageEventRecord.tenant に刻む(非 null 時のみ)", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const withTenant = await lineage.record(
      "intent.observed",
      { intentHash: "h" },
      { kind: "system" },
      "acme",
    );
    const withoutTenant = await lineage.record("intent.observed", { intentHash: "h" });
    expect(withTenant.tenant).toBe("acme");
    expect("tenant" in withoutTenant).toBe(false);
  });

  it("viewComposed は tenant を view.composed / component.generated / component.used に貫通する", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec();
    await lineage.viewComposed({ spec, trace, surface: "chat", sessionId: "s1", tenant: "acme" });

    // An L2 spec, so 3 events. All are stamped into the record's tenant field.
    expect(storage.events.map((e) => e.type)).toEqual([
      "view.composed",
      "component.generated",
      "component.used",
    ]);
    expect(storage.events.every((e) => e.tenant === "acme")).toBe(true);
    // tenant is not mixed into the payload (only the record's tenant field).
    expect("tenant" in storage.events[0]!.payload).toBe(false);
  });

  it("component.generated はテナントごとに初回目撃時に記録する(cache:hit の tenant B も昇格候補になる。L1)", async () => {
    // Because the Spec cache is tenant-neutral, tenant B receives the same Spec generated (miss) by tenant A as
    // cache:hit. The old implementation had (a) a tenant-independent dedup lookup that found A's record, (b) a
    // known set keyed by artifactId alone, and (c) a miss/bypass-only gate that rejected cache:hit, so tenant B's
    // component.generated was never recorded and never appeared as a promotion candidate.
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec(); // provenance.cache === "miss"
    const artifactId = artifactIdOf(spec.components[1]!.artifact!.sha256);

    // tenant acme: generate on miss -> component.generated is recorded for acme.
    await lineage.viewComposed({ spec, trace, surface: "web", sessionId: "s1", tenant: "acme" });

    // tenant globex: receives the same Spec as cache:hit (the Spec cache is tenant-neutral).
    const hitSpec: UISpec = { ...spec, provenance: { ...spec.provenance, cache: "hit" } };
    await lineage.viewComposed({
      spec: hitSpec,
      trace: { ...trace, cache: "hit" },
      surface: "web",
      sessionId: "s2",
      tenant: "globex",
    });

    // component.generated is recorded once for each tenant (recorded even on cache:hit if not yet recorded for that tenant).
    const generated = storage.events.filter((e) => e.type === "component.generated");
    expect(generated.map((e) => e.tenant).sort()).toEqual(["acme", "globex"]);

    // A promotion candidate is obtained for tenant globex too (because loadCandidate narrows strictly by tenant,
    // without component.generated for globex the candidate would never appear <- resolved by this fix).
    const promotions = createPromotions({
      lineage,
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });
    expect(await promotions.get(artifactId, { tenant: "acme" })).not.toBeNull();
    expect(await promotions.get(artifactId, { tenant: "globex" })).not.toBeNull();
    // It also appears in the globex-scope list, and uses counts only globex's component.used (1).
    const globexCandidates = await promotions.list({ tenant: "globex" });
    expect(globexCandidates.map((c) => c.artifactId)).toEqual([artifactId]);
    expect(globexCandidates[0]!.uses).toBe(1);
  });

  it("同一テナントの cache:hit は component.generated を二重記録しない(3-12a のテナント単位維持)", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const spec = await l2Spec();

    // acme: miss -> generated 1 + used 1.
    await lineage.viewComposed({ spec, trace, surface: "web", tenant: "acme" });
    // acme: re-receives the same artifactId as cache:hit -> a known-set hit means generated does not increase, only used.
    await lineage.viewComposed({
      spec: { ...spec, provenance: { ...spec.provenance, cache: "hit" } },
      trace: { ...trace, cache: "hit" },
      surface: "web",
      tenant: "acme",
    });

    const generated = storage.events.filter((e) => e.type === "component.generated" && e.tenant === "acme");
    const used = storage.events.filter((e) => e.type === "component.used" && e.tenant === "acme");
    expect(generated).toHaveLength(1);
    expect(used).toHaveLength(2);
  });

  it("evaluateAndList({tenant}) は他テナントの利用を数えない(未指定は全件 = 回帰)", async () => {
    const storage = memoryStorage();
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 2, minDistinctSessions: 1, judgeBlocking: false },
    });
    // tenant acme's component a1 (uses=2)
    await storage.appendLineage(evT("component.generated", { artifactId: "a1", request: "r" }, "acme"));
    await storage.appendLineage(evT("component.used", { artifactId: "a1", sessionId: "s1" }, "acme"));
    await storage.appendLineage(evT("component.used", { artifactId: "a1", sessionId: "s2" }, "acme"));
    // tenant globex's component b1 (uses=2)
    await storage.appendLineage(evT("component.generated", { artifactId: "b1", request: "r" }, "globex"));
    await storage.appendLineage(evT("component.used", { artifactId: "b1", sessionId: "s3" }, "globex"));
    await storage.appendLineage(evT("component.used", { artifactId: "b1", sessionId: "s4" }, "globex"));

    // In the acme scope only a1 is made a candidate, and globex's b1 usage is not counted.
    const acme = await promotions.evaluateAndList({ tenant: "acme" });
    expect(acme.map((c) => c.artifactId)).toEqual(["a1"]);
    expect(acme[0]!.uses).toBe(2);
    // nominate is stamped for acme too (so re-evaluation in the tenant scope is idempotent).
    const nominated = storage.events.filter((e) => e.type === "component.nominated");
    expect(nominated).toHaveLength(1);
    expect(nominated[0]!.tenant).toBe("acme");

    // Unset (no scope) means all tenants combined = the regression of the legacy behavior.
    const all = await promotions.list();
    expect(all.map((c) => c.artifactId).sort()).toEqual(["a1", "b1"]);
  });

  it("proposals({tenant}) は当該テナントの頻出 Intent のみを候補化する(未指定は全件)", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 2, minDistinctSessions: 1, structuralStability: 0.9 },
    });
    // acme: intentHash hA in 2 sessions at L1 (structurally stable)
    for (const s of ["s1", "s2"]) {
      await storage.appendLineage(
        evT(
          "view.composed",
          { tier: "L1", intentHash: "hA", canonical: "sales.a", sessionId: s, structureHash: "st" },
          "acme",
        ),
      );
    }
    // globex: intentHash hB in 2 sessions at L1
    for (const s of ["s3", "s4"]) {
      await storage.appendLineage(
        evT(
          "view.composed",
          { tier: "L1", intentHash: "hB", canonical: "sales.b", sessionId: s, structureHash: "st" },
          "globex",
        ),
      );
    }

    const acme = await fixations.proposals({ tenant: "acme" });
    expect(acme.map((p) => p.intentHash)).toEqual(["hA"]);
    // When unset, both tenants' Intents become candidates (regression).
    const all = await fixations.proposals();
    expect(all.map((p) => p.intentHash).sort()).toEqual(["hA", "hB"]);
  });

  it("get(artifactId, tenant) は帰属テナント一致のみ返す(未指定は全件 = 回帰)", async () => {
    const storage = memoryStorage();
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });
    // artifact a1 is generated by acme (component.generated belongs to acme).
    await storage.appendLineage(evT("component.generated", { artifactId: "a1", request: "r" }, "acme"));

    expect(await promotions.get("a1", { tenant: "acme" })).not.toBeNull();
    // Treated as non-existent for another tenant (globex).
    expect(await promotions.get("a1", { tenant: "globex" })).toBeNull();
    // Unset means all = legacy behavior.
    expect(await promotions.get("a1")).not.toBeNull();
  });

  it("act は別テナントの候補を操作できず(unknown artifact)、同一テナントの記録に tenant を刻む", async () => {
    const storage = memoryStorage();
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 2, minDistinctSessions: 1, judgeBlocking: false },
    });
    await storage.appendLineage(evT("component.generated", { artifactId: "a1", request: "r" }, "acme"));
    const actor: Principal = { id: "admin" };

    // From another tenant (globex), the ownership mismatch hides the candidate, giving unknown artifact.
    await expect(
      promotions.act("a1", { kind: "nominate", by: actor }, actor, { tenant: "globex" }),
    ).rejects.toThrow(/unknown artifact/);
    // The same tenant (acme) succeeds, and component.nominated is stamped for acme.
    const acted = await promotions.act("a1", { kind: "nominate", by: actor }, actor, { tenant: "acme" });
    expect(acted.status).toBe("candidate");
    const nominated = storage.events.filter((e) => e.type === "component.nominated");
    expect(nominated).toHaveLength(1);
    expect(nominated[0]!.tenant).toBe("acme");
  });

  /** In-memory storage that key-separates promotion state by (tenant, artifactId) (same convention as FileStoragePort). */
  function tenantPromotionStorage(): StoragePort & { events: LineageEventRecord[] } {
    const base = memoryStorage();
    const states = new Map<string, PromotionState>();
    const key = (artifactId: string, tenant?: string) =>
      tenant != null && tenant !== "" ? `${tenant} ${artifactId}` : artifactId;
    return {
      ...base,
      async getPromotionState(artifactId, tenant) {
        return states.get(key(artifactId, tenant)) ?? null;
      },
      async putPromotionState(state) {
        states.set(key(state.artifactId, state.tenant), state);
      },
      async listPromotionStates(tenant) {
        const all = [...states.values()];
        return tenant == null ? all : all.filter((s) => s.tenant === tenant);
      },
    };
  }

  it("同一 artifactId の昇格状態はテナントで分離される(片方の approve/reject が他方に波及しない)", async () => {
    const storage = tenantPromotionStorage();
    const reviewer: Principal = { id: "admin" };
    const draft: ComponentDraft = {
      componentType: "sales.customX",
      version: "1.0.0",
      intentName: "sales.customX",
      description: "テスト用ドラフト",
    };
    // acme and globex each generate the same artifactId "a1" (their owning tenants differ).
    await storage.appendLineage(
      evT("component.generated", { artifactId: "a1", html: "<html></html>", request: "r" }, "acme"),
    );
    await storage.appendLineage(
      evT("component.generated", { artifactId: "a1", html: "<html></html>", request: "r" }, "globex"),
    );
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      // judge treated as advisory to pass all the way to published (judge unset).
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });

    // approve on acme -> published (acme scope only).
    const acmeApproved = await promotions.approve("a1", draft, reviewer, { tenant: "acme" });
    expect(acmeApproved.status).toBe("published");
    // globex's state is unaffected and stays in_use (states do not get mixed).
    expect((await promotions.get("a1", { tenant: "globex" }))?.status).toBe("in_use");

    // reject on globex -> rejected (globex scope only).
    const globexRejected = await promotions.reject("a1", reviewer, { tenant: "globex" });
    expect(globexRejected.status).toBe("rejected");
    // acme stays published (globex's reject does not propagate).
    expect((await promotions.get("a1", { tenant: "acme" }))?.status).toBe("published");

    // listPromotionStates is also separated by tenant.
    expect((await storage.listPromotionStates("acme")).map((s) => s.status)).toEqual(["published"]);
    expect((await storage.listPromotionStates("globex")).map((s) => s.status)).toEqual(["rejected"]);
  });
});
