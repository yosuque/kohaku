import type { LineageEventRecord, Principal, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * Audit stamping of rubric versioning, and reconciling the fact that a human overrode the judge result.
 * - rubricId / rubricVersion are additively stamped into the component.judged verdict.
 * - Human approval/rejection can be tracked via the existing component.reviewed (decision), and reconciling
 *   judged and reviewed by artifactId lets an audit query detect "a human overrode a judge failure with an approval."
 *   No new event type is needed (it works with the existing vocabulary).
 */

function memoryStorage(): StoragePort & { events: LineageEventRecord[] } {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
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
    async getPromotionState(id) {
      return states.get(id) ?? null;
    },
    async putPromotionState(state) {
      states.set(state.artifactId, state);
    },
    async listPromotionStates() {
      return [...states.values()];
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

const draft: ComponentDraft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

function generated(storage: StoragePort & { events: LineageEventRecord[] }, artifactId: string) {
  storage.events.push({
    id: `g-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: "<html></html>", request: "r" },
  });
}

/** An audit query that reconciles the judge verdict and the human review decision from history (component.* provenance). */
function auditOverride(history: LineageEventRecord[]): {
  judgedPass?: boolean;
  rubricId?: string;
  rubricVersion?: string;
  decision?: string;
  humanOverrodeJudge: boolean;
} {
  const judged = history.find((e) => e.type === "component.judged");
  const reviewed = history.find((e) => e.type === "component.reviewed");
  const verdict = judged?.payload["verdict"] as
    | { pass?: boolean; rubricId?: string; rubricVersion?: string }
    | undefined;
  const decision = reviewed?.payload["decision"] as string | undefined;
  // override = the judge failed but the human approved, or the judge passed but the human rejected.
  const humanOverrodeJudge =
    verdict != null &&
    decision != null &&
    ((verdict.pass === false && decision === "approve") || (verdict.pass === true && decision === "reject"));
  return {
    judgedPass: verdict?.pass,
    rubricId: verdict?.rubricId,
    rubricVersion: verdict?.rubricVersion,
    decision,
    humanOverrodeJudge,
  };
}

describe("rubric version stamping in promotion review + auditing human override", () => {
  const reviewer: Principal = { id: "admin-1" };

  it("rubricId / rubricVersion are stamped into the component.judged verdict (additive)", async () => {
    const storage = memoryStorage();
    generated(storage, "a1");
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
      judge: async () => ({
        pass: true,
        score: 0.82,
        rubricId: "l2-promotion",
        rubricVersion: "0.1",
      }),
    });

    const result = await promotions.approve("a1", draft, reviewer);
    expect(result.status).toBe("published");

    const judged = storage.events.find((e) => e.type === "component.judged");
    const verdict = judged!.payload["verdict"] as Record<string, unknown>;
    expect(verdict["rubricId"]).toBe("l2-promotion");
    expect(verdict["rubricVersion"]).toBe("0.1");
    expect(verdict["pass"]).toBe(true);
  });

  it("a human overriding a judge failure with approve is detectable by reconciling judged × reviewed", async () => {
    const storage = memoryStorage();
    generated(storage, "a1");
    // judgeBlocking:false = even on a judge failure it proceeds to in_review as advisory, and the human makes the final decision.
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
      judge: async () => ({
        pass: false,
        score: 0.3,
        reason: "low generality",
        rubricId: "l2-promotion",
        rubricVersion: "0.1",
      }),
    });

    // The human reviewer approves (overriding the judge's failure verdict).
    const result = await promotions.approve("a1", draft, reviewer);
    expect(result.status).toBe("published");

    const history = await createLineage({ storage }).history("a1");
    const audit = auditOverride(history);
    expect(audit.judgedPass).toBe(false);
    expect(audit.rubricId).toBe("l2-promotion");
    expect(audit.rubricVersion).toBe("0.1");
    expect(audit.decision).toBe("approve");
    // judge failure × human approve = the override is detectable via an audit query (no new event type).
    expect(audit.humanOverrodeJudge).toBe(true);
  });

  it("judge pass × human approve is concordant (not an override)", async () => {
    const storage = memoryStorage();
    generated(storage, "a1");
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
      judge: async () => ({ pass: true, score: 0.9, rubricId: "l2-promotion", rubricVersion: "0.1" }),
    });

    await promotions.approve("a1", draft, reviewer);
    const history = await createLineage({ storage }).history("a1");
    const audit = auditOverride(history);
    expect(audit.judgedPass).toBe(true);
    expect(audit.decision).toBe("approve");
    expect(audit.humanOverrodeJudge).toBe(false);
  });
});
