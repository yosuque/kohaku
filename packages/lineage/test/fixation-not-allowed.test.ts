import type { FixationRecord, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createFixations, createLineage, FixationNotAllowedError } from "../src/index.js";

// SPEC.md §8: a Spec carrying provenance.fallback, and a tier-L2 result, MUST NOT be fixated. The rule lives in
// Fixations.fixate itself so every caller is covered, not only the REST route.

const HASH = "sha256:" + "0".repeat(64);
const approver = { id: "tester" };

function spec(provenance: UISpec["provenance"]): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: HASH },
    dataVersion: "pinned@v0",
    components: [{ id: "root", type: "presentMarkdown", props: { markdown: "pinned" } }],
    events: [],
    provenance,
  };
}

function harness() {
  const fixed = new Map<string, FixationRecord>();
  const events: string[] = [];
  const storage = {
    async getFixation(h: string) {
      return fixed.get(h) ?? null;
    },
    async putFixation(rec: FixationRecord) {
      fixed.set(rec.intentHash, rec);
    },
    async listFixations() {
      return [...fixed.values()];
    },
    async listLineage() {
      return [];
    },
    async appendLineage(e: { type: string }) {
      events.push(e.type);
    },
  } as unknown as StoragePort;
  return { fixed, events, fixations: createFixations({ lineage: createLineage({ storage }), storage }) };
}

describe("Fixations.fixate rejects a Spec that must not become the L0 fast path", () => {
  it("rejects a Spec carrying provenance.fallback, writing neither state nor audit", async () => {
    const { fixed, events, fixations } = harness();
    const pinned = spec({
      tier: "L1",
      composedBy: "fixture",
      cache: "miss",
      fallback: { from: "root", reason: "generation exhausted", kind: "generation" },
    });
    const err = await fixations.fixate({ pinnedSpec: pinned, approver }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixationNotAllowedError);
    expect((err as FixationNotAllowedError).reason).toBe("fallback");
    expect(fixed.size).toBe(0);
    expect(events).toEqual([]);
  });

  it("rejects a tier-L2 Spec", async () => {
    const { fixed, fixations } = harness();
    const err = await fixations
      .fixate({ pinnedSpec: spec({ tier: "L2", composedBy: "fixture", cache: "miss" }), approver })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixationNotAllowedError);
    expect((err as FixationNotAllowedError).reason).toBe("l2-tier");
    expect(fixed.size).toBe(0);
  });

  it("still fixates an ordinary L1 Spec", async () => {
    const { fixed, fixations } = harness();
    const record = await fixations.fixate({
      pinnedSpec: spec({ tier: "L1", composedBy: "fixture", cache: "miss" }),
      approver,
    });
    expect(fixed.get(record.intentHash)).toBeDefined();
  });
});
