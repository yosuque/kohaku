import { describe, expect, it } from "vitest";
import { FixationRecordSchema, LineageEventRecordSchema, PromotionStateSchema } from "../src/index.js";

const HASH = "sha256:" + "0".repeat(64);

function validPinnedSpec() {
  return {
    kohaku: "0.1" as const,
    intent: { canonical: "sales.trend", params: {}, hash: HASH },
    dataVersion: "pinned@v0",
    components: [{ id: "root", type: "presentMarkdown", props: { markdown: "pinned" } }],
    events: [],
    provenance: { tier: "L0" as const, composedBy: "fixture", cache: "miss" as const },
  };
}

function validFixationRecord() {
  return {
    intentHash: HASH,
    canonical: "sales.trend",
    structureHash: "sha256:" + "1".repeat(64),
    pinnedSpec: validPinnedSpec(),
    fixatedAt: "2026-07-01T00:00:00Z",
    approver: { id: "tester" },
  };
}

describe("FixationRecordSchema", () => {
  it("accepts a minimal valid record", () => {
    expect(FixationRecordSchema.safeParse(validFixationRecord()).success).toBe(true);
  });

  it("accepts the optional catalogFingerprint / tenant / revision fields", () => {
    const record = {
      ...validFixationRecord(),
      catalogFingerprint: "sha256:fp",
      tenant: "acme",
      revision: "abc123-xyz",
    };
    expect(FixationRecordSchema.safeParse(record).success).toBe(true);
  });

  it("rejects a record whose pinnedSpec fails UISpecSchema (components empty)", () => {
    const record = { ...validFixationRecord(), pinnedSpec: { ...validPinnedSpec(), components: [] } };
    expect(FixationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a record with a non-string approver.id", () => {
    const record = { ...validFixationRecord(), approver: { id: 42 } };
    expect(FixationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a record missing pinnedSpec entirely (e.g. a truncated write)", () => {
    const { pinnedSpec: _omit, ...withoutPinnedSpec } = validFixationRecord();
    expect(FixationRecordSchema.safeParse(withoutPinnedSpec).success).toBe(false);
  });
});

describe("PromotionStateSchema", () => {
  const base = { artifactId: "art1", status: "in_use", updatedAt: "2026-07-01T00:00:00Z", data: {} };

  it("accepts a minimal valid state", () => {
    expect(PromotionStateSchema.safeParse(base).success).toBe(true);
  });

  it("accepts the optional tenant field", () => {
    expect(PromotionStateSchema.safeParse({ ...base, tenant: "acme" }).success).toBe(true);
  });

  it("keeps `data` loose enough for the published projection fields (html / sha256 / ref / componentType)", () => {
    const published = {
      ...base,
      status: "published",
      data: {
        verdict: { pass: true, score: 0.9 },
        draft: { componentType: "sales.custom-widget", version: "1", intentName: "x.y", description: "d" },
        html: "<div>rendered</div>",
        sha256: "a".repeat(64),
        ref: "custom-components/art1.html",
        componentType: "sales.custom-widget",
      },
    };
    expect(PromotionStateSchema.safeParse(published).success).toBe(true);
  });

  it("rejects a non-string status (a corrupted record)", () => {
    expect(PromotionStateSchema.safeParse({ ...base, status: 42 }).success).toBe(false);
  });

  it("rejects a non-object data (a corrupted record)", () => {
    expect(PromotionStateSchema.safeParse({ ...base, data: "not-an-object" }).success).toBe(false);
  });
});

describe("LineageEventRecordSchema", () => {
  const base = {
    id: "e1",
    ts: "2026-07-01T00:00:00Z",
    actor: { kind: "system" as const },
    type: "intent.fixated",
    payload: { intentHash: HASH },
  };

  it("accepts a minimal valid event", () => {
    expect(LineageEventRecordSchema.safeParse(base).success).toBe(true);
  });

  it("accepts an unrecognized future event type (the vocabulary is owned by @kohaku-ui/lineage, not spec-core)", () => {
    expect(LineageEventRecordSchema.safeParse({ ...base, type: "some.future.event" }).success).toBe(true);
  });

  it("accepts the optional tenant field and actor.id / actor.model", () => {
    const event = {
      ...base,
      tenant: "acme",
      actor: { kind: "model" as const, id: "u1", model: "gpt-x" },
    };
    expect(LineageEventRecordSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an invalid actor.kind (a corrupted record)", () => {
    const event = { ...base, actor: { kind: "robot" } };
    expect(LineageEventRecordSchema.safeParse(event).success).toBe(false);
  });
});
