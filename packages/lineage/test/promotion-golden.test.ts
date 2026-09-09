import type { LineageEventRecord, Principal, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * Characterization (golden) test written BEFORE the God-factory split of createPromotions
 * (candidate-store / nomination extraction). Locks down the *exact* shape (key set AND key
 * order, verified via JSON.stringify) of the record persisted via StoragePort.putPromotionState
 * at the end of the nominate -> judge.start -> judge.result -> review.approve -> schema.propose ->
 * publish chain. A behavior-preserving refactor must keep this byte-identical (updatedAt excepted,
 * since it is a wall-clock timestamp and is normalized before comparison).
 *
 * Updated for #9 (self-contained published projection): the publish transition now additionally copies
 * html/sha256/ref/componentType onto the snapshot's `data` (after verdict/draft/request, only when the
 * candidate's status is "published"), so `reconcile` can rebuild the projection from the snapshot alone even if
 * lineage.jsonl (and hence the component.generated event) is lost or replaced. This is a deliberate,
 * intentional change to the persisted shape — not a regression of this characterization test.
 */

function memoryStorageWithStates(): StoragePort & {
  events: LineageEventRecord[];
  putCalls: PromotionState[];
} {
  const events: LineageEventRecord[] = [];
  const putCalls: PromotionState[] = [];
  const states = new Map<string, PromotionState>();
  const key = (id: string, tenant?: string) => (tenant != null ? `${tenant}::${id}` : id);
  return {
    events,
    putCalls,
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
      putCalls.push(state);
      states.set(key(state.artifactId, state.tenant), state);
    },
    async listPromotionStates(tenant) {
      const all = [...states.values()];
      return tenant == null ? all : all.filter((s) => s.tenant === tenant);
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

/** Builds a component.generated lineage event stamped with tenant, mirroring lineage.test.ts's evT. */
function generatedEvent(artifactId: string, tenant: string | undefined): LineageEventRecord {
  return {
    id: `g-${artifactId}-${tenant ?? ""}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: {
      artifactId,
      artifactSha256: "a".repeat(64),
      canonical: "sales.custom",
      request: "ヒートマップで",
      html: "<html>golden</html>",
      ref: "query://sales/trend?metric=revenue",
    },
    ...(tenant != null ? { tenant } : {}),
  };
}

const reviewer: Principal = { id: "admin" };
const draft: ComponentDraft = {
  componentType: "sales.customX",
  version: "2.0.0",
  intentName: "sales.customX",
  description: "golden draft",
};
const verdict = { pass: true, score: 0.9 };

/** Drives the full nominate -> judge.start -> judge.result -> review.approve -> schema.propose -> publish chain via act(). */
async function runChain(
  storage: StoragePort & { events: LineageEventRecord[]; putCalls: PromotionState[] },
  artifactId: string,
  tenant?: string,
): Promise<void> {
  const promotions = createPromotions({
    lineage: createLineage({ storage }),
    storage,
    policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
  });
  const scope = tenant != null ? { tenant } : undefined;
  await storage.appendLineage(generatedEvent(artifactId, tenant));

  await promotions.act(artifactId, { kind: "nominate", by: reviewer }, reviewer, scope);
  await promotions.act(artifactId, { kind: "judge.start" }, reviewer, scope);
  await promotions.act(artifactId, { kind: "judge.result", verdict }, reviewer, scope);
  await promotions.act(
    artifactId,
    { kind: "review.approve", reviewer, comment: "approved via golden test" },
    reviewer,
    scope,
  );
  await promotions.act(artifactId, { kind: "schema.propose", draft }, reviewer, scope);
  await promotions.act(artifactId, { kind: "publish", version: draft.version }, reviewer, scope);
}

/** Normalizes updatedAt to a fixed sentinel (same key position) so the timestamp does not defeat the golden compare. */
function normalize(state: PromotionState): PromotionState {
  return { ...state, updatedAt: "TS" };
}

describe("promotion 永続化のゴールデン(#golden, God-factory 分割前の特性テスト)", () => {
  it("nominate→judge.start→judge.result→review.approve→schema.propose→publish の連鎖後、永続レコードのキー集合と順序が一致する", async () => {
    const storage = memoryStorageWithStates();
    await runChain(storage, "golden-1");

    const last = storage.putCalls[storage.putCalls.length - 1]!;
    expect(JSON.stringify(normalize(last))).toBe(
      JSON.stringify({
        artifactId: "golden-1",
        status: "published",
        updatedAt: "TS",
        data: {
          verdict,
          draft,
          request: "ヒートマップで",
          html: "<html>golden</html>",
          sha256: "a".repeat(64),
          ref: "query://sales/trend?metric=revenue",
          componentType: draft.componentType,
        },
      }),
    );

    // Sanity: the read-back path (get) sees the same terminal state.
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });
    const readBack = await promotions.get("golden-1");
    expect(readBack?.status).toBe("published");
    expect(readBack?.verdict).toEqual(verdict);
    expect(readBack?.draft).toEqual(draft);
  });

  it("テナント指定時も同じキー順序(tenant は updatedAt の直後、data の中身は不変)", async () => {
    const storage = memoryStorageWithStates();
    await runChain(storage, "golden-2", "acme");

    const last = storage.putCalls[storage.putCalls.length - 1]!;
    expect(JSON.stringify(normalize(last))).toBe(
      JSON.stringify({
        artifactId: "golden-2",
        status: "published",
        updatedAt: "TS",
        tenant: "acme",
        data: {
          verdict,
          draft,
          request: "ヒートマップで",
          html: "<html>golden</html>",
          sha256: "a".repeat(64),
          ref: "query://sales/trend?metric=revenue",
          componentType: draft.componentType,
        },
      }),
    );
  });

  it("連鎖の各段階で永続レコードのキー集合が段階どおりに増える(verdict → draft の順で data に現れる)", async () => {
    const storage = memoryStorageWithStates();
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });
    await storage.appendLineage(generatedEvent("golden-3", undefined));

    await promotions.act("golden-3", { kind: "nominate", by: reviewer }, reviewer);
    expect(Object.keys(storage.putCalls[0]!.data)).toEqual(["request"]);

    await promotions.act("golden-3", { kind: "judge.start" }, reviewer);
    expect(Object.keys(storage.putCalls[1]!.data)).toEqual(["request"]);

    await promotions.act("golden-3", { kind: "judge.result", verdict }, reviewer);
    expect(Object.keys(storage.putCalls[2]!.data)).toEqual(["verdict", "request"]);

    await promotions.act("golden-3", { kind: "review.approve", reviewer, comment: "ok" }, reviewer);
    expect(Object.keys(storage.putCalls[3]!.data)).toEqual(["verdict", "request"]);

    await promotions.act("golden-3", { kind: "schema.propose", draft }, reviewer);
    expect(Object.keys(storage.putCalls[4]!.data)).toEqual(["verdict", "draft", "request"]);

    await promotions.act("golden-3", { kind: "publish", version: draft.version }, reviewer);
    // The publish step additionally copies html/sha256/ref/componentType (#9's self-contained projection).
    expect(Object.keys(storage.putCalls[5]!.data)).toEqual([
      "verdict",
      "draft",
      "request",
      "html",
      "sha256",
      "ref",
      "componentType",
    ]);
    expect(storage.putCalls[5]!.status).toBe("published");
  });
});
