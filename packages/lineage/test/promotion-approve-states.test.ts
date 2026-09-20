import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type ComponentDraft,
  createLineage,
  createPromotions,
  PromotionNotPublishedError,
  type PromotionStatus,
  type Promotions,
} from "../src/index.js";

/**
 * approve() must resume correctly from every one of the 11 PromotionStatus values, including "judging" -- the
 * state a candidate is persisted at when the process dies between judge.start and judge.result. Before the fix,
 * a candidate stuck at "judging" matched none of approve()'s if-steps and fell through to
 * PromotionNotPublishedError, even though machine.ts's judging --judge.result--> in_review | judge_failed edge
 * exists (a resumable state, not a dead end).
 *
 * This table drives a candidate to each status via the real state machine (`act`, not a hand-written storage
 * record), then calls approve() and asserts the *actual* outcome -- not the outcome predicted for it, so a
 * discrepancy between prediction and reality would show up as a wrong assertion caught while writing the test
 * rather than being silently encoded.
 */

function memoryStorage(): StoragePort & { events: LineageEventRecord[] } {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const key = (id: string, tenant?: string) => `${tenant ?? ""}::${id}`;
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

function seedGenerated(storage: StoragePort & { events: LineageEventRecord[] }, artifactId: string): void {
  storage.events.push({
    id: `g-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: `<html>${artifactId}</html>`, request: "r" },
  });
}

const actor = { id: "reviewer-1" };

const draft: ComponentDraft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

/**
 * Drives a freshly-generated candidate to `status` using the real machine transitions (`act`), so the seed
 * itself exercises the same code path a real crash-and-resume would have left behind (in particular, "judging"
 * is seeded via a real judge.start with no matching judge.result -- exactly "the process died in between").
 */
async function seedStatus(
  promotions: Promotions,
  artifactId: string,
  status: PromotionStatus,
): Promise<void> {
  switch (status) {
    case "in_use":
      return;
    case "candidate":
      await promotions.act(artifactId, { kind: "nominate", by: actor }, actor);
      return;
    case "judging":
      await seedStatus(promotions, artifactId, "candidate");
      await promotions.act(artifactId, { kind: "judge.start" }, actor);
      return;
    case "judge_failed":
      await seedStatus(promotions, artifactId, "judging");
      await promotions.act(artifactId, { kind: "judge.result", verdict: { pass: false, score: 0 } }, actor);
      return;
    case "in_review":
      // review.start reaches in_review directly from candidate, skipping the judge stage (a valid machine edge),
      // so seeding in_review does not depend on the judge stage's own behaviour.
      await seedStatus(promotions, artifactId, "candidate");
      await promotions.act(artifactId, { kind: "review.start" }, actor);
      return;
    case "changes_requested":
      await seedStatus(promotions, artifactId, "in_review");
      await promotions.act(artifactId, { kind: "review.requestChanges", reviewer: actor }, actor);
      return;
    case "approved":
      await seedStatus(promotions, artifactId, "in_review");
      await promotions.act(artifactId, { kind: "review.approve", reviewer: actor }, actor);
      return;
    case "schema_proposed":
      await seedStatus(promotions, artifactId, "approved");
      await promotions.act(artifactId, { kind: "schema.propose", draft }, actor);
      return;
    case "published":
      await seedStatus(promotions, artifactId, "schema_proposed");
      await promotions.act(artifactId, { kind: "publish", version: draft.version }, actor);
      return;
    case "rejected":
      await seedStatus(promotions, artifactId, "in_review");
      await promotions.act(artifactId, { kind: "review.reject", reviewer: actor }, actor);
      return;
    case "withdrawn":
      // withdraw is valid from any non-terminal status; in_use (the default, no seeding needed) is simplest.
      await promotions.act(artifactId, { kind: "withdraw" }, actor);
      return;
  }
}

/** Expected real outcome of approve() from each of the 11 statuses (see the table's own doc above). */
const OUTCOMES: Record<PromotionStatus, "published" | "error"> = {
  in_use: "published",
  candidate: "published",
  judging: "published",
  judge_failed: "published",
  in_review: "published",
  changes_requested: "published",
  approved: "published",
  schema_proposed: "published",
  published: "published",
  rejected: "error",
  withdrawn: "error",
};

describe("promotions.approve() は 11 状態すべてから正しく再開する", () => {
  for (const [status, outcome] of Object.entries(OUTCOMES) as [PromotionStatus, "published" | "error"][]) {
    it(`status="${status}" -> ${outcome === "published" ? "published" : "PromotionNotPublishedError"}`, async () => {
      const storage = memoryStorage();
      const artifactId = `art-${status}`;
      seedGenerated(storage, artifactId);

      const applied: string[] = [];
      const promotions = createPromotions({
        lineage: createLineage({ storage }),
        storage,
        judge: async () => ({ pass: true, score: 1 }),
        onPublish: async ({ artifactId: id }) => {
          applied.push(id);
        },
      });

      await seedStatus(promotions, artifactId, status);

      if (outcome === "published") {
        const result = await promotions.approve(artifactId, draft, actor);
        expect(result.status).toBe("published");
        expect((await storage.getPromotionState(artifactId))?.status).toBe("published");
      } else {
        await expect(promotions.approve(artifactId, draft, actor)).rejects.toThrow(
          PromotionNotPublishedError,
        );
        // An error row must not have published anything.
        expect(applied).toHaveLength(0);
      }
    });
  }
});

describe("approve() の judging 再開は二重ジャッジしない", () => {
  it("judging から再開した approve() は judge を 1 回だけ呼ぶ(新しい判定ブロックの再入なし)", async () => {
    const storage = memoryStorage();
    const artifactId = "art-judging-once";
    seedGenerated(storage, artifactId);

    let judgeCalls = 0;
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      judge: async () => {
        judgeCalls++;
        return { pass: true, score: 1 };
      },
      onPublish: async () => {},
    });

    // Seed exactly what a crash between judge.start and judge.result leaves behind: judging, no verdict recorded.
    await seedStatus(promotions, artifactId, "judging");
    expect((await storage.getPromotionState(artifactId))?.status).toBe("judging");

    const result = await promotions.approve(artifactId, draft, actor);

    expect(result.status).toBe("published");
    // Exactly one judge call: the resume block runs the judge once and, because judge.result immediately moves
    // the candidate to in_review/judge_failed, the same block cannot see status "judging" again afterward.
    expect(judgeCalls).toBe(1);
  });

  it("candidate から始めた approve() も judge を 1 回だけ呼ぶ(judging 再開ブロックへ二重に入らない)", async () => {
    const storage = memoryStorage();
    const artifactId = "art-candidate-once";
    seedGenerated(storage, artifactId);

    let judgeCalls = 0;
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      judge: async () => {
        judgeCalls++;
        return { pass: true, score: 1 };
      },
      onPublish: async () => {},
    });

    await seedStatus(promotions, artifactId, "candidate");

    const result = await promotions.approve(artifactId, draft, actor);

    expect(result.status).toBe("published");
    // The candidate branch runs judge.start + runJudge + judge.result itself, landing on in_review, which is
    // not "judging" -- so the judging-resume block added for the crash case is never entered on this path.
    expect(judgeCalls).toBe(1);
  });
});
