import type { CanonicalIntent, FixationRecord, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createFixationFewShot } from "../src/fewshot.js";

/** Minimal structure for a single fixation (only pinnedSpec's canonical / components / events are mapped). */
function fixation(canonical: string, intentHash: string): FixationRecord {
  const spec: UISpec = {
    kohaku: "0.2",
    intent: { canonical, params: { tag: canonical }, hash: intentHash },
    dataVersion: "sales@1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["h"] },
      { id: "h", type: "text.heading", props: { level: 2, text: canonical } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "test", cache: "fixated" },
  };
  return {
    intentHash,
    canonical,
    structureHash: "sha256:structure",
    pinnedSpec: spec,
    fixatedAt: "2026-07-02T00:00:00.000Z",
    approver: { id: "tester" },
  };
}

/** A minimal StoragePort stub where only listFixations can be swapped. */
function storageWith(fixations: FixationRecord[]): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage() {
      return [];
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
      return fixations;
    },
  };
}

const INTENT: CanonicalIntent = {
  canonical: "sales.trend",
  params: {},
  hash: `sha256:${"0".repeat(64)}`,
};

describe("createFixationFewShot (3-9): deterministic good-example supply", () => {
  it("zero fixations yields an empty array", async () => {
    const fewShot = createFixationFewShot(storageWith([]));
    expect(await fewShot.examples(INTENT)).toEqual([]);
  });

  it("prefers canonical matches, then the first 2 by ascending intentHash", async () => {
    const hashA = `sha256:${"a".repeat(64)}`; // match (trend)
    const hashB = `sha256:${"b".repeat(64)}`; // match (trend)
    const hashC = `sha256:${"c".repeat(64)}`; // match (trend) but larger hash
    const hashZ = `sha256:${"1".repeat(64)}`; // non-match (other). smaller hash but deprioritized
    const fewShot = createFixationFewShot(
      storageWith([
        fixation("sales.other", hashZ),
        fixation("sales.trend", hashC),
        fixation("sales.trend", hashA),
        fixation("sales.trend", hashB),
      ]),
    );
    const examples = await fewShot.examples(INTENT);
    // The 3 matches come first in ascending intentHash order (a < b < c), and the first 2 = a, b
    expect(examples.map((e) => e.intent.canonical)).toEqual(["sales.trend", "sales.trend"]);
    expect(examples[0]!.intent.params).toEqual({ tag: "sales.trend" });
    // Only pinnedSpec's components / events are mapped; provenance etc. are not carried over
    expect(examples[0]!.spec).toHaveProperty("components");
    expect(examples[0]!.spec).toHaveProperty("events");
    expect(examples[0]!.spec).not.toHaveProperty("provenance");
    expect(examples[0]!.spec.components[0]!.id).toBe("root");
  });

  it("with no matches, takes the first 2 by ascending intentHash from non-matches (does not stop supplying)", async () => {
    const h1 = `sha256:${"1".repeat(64)}`;
    const h2 = `sha256:${"2".repeat(64)}`;
    const h3 = `sha256:${"3".repeat(64)}`;
    const fewShot = createFixationFewShot(
      storageWith([fixation("sales.a", h3), fixation("sales.b", h1), fixation("sales.c", h2)]),
    );
    const examples = await fewShot.examples(INTENT);
    expect(examples.map((e) => e.intent.canonical)).toEqual(["sales.b", "sales.c"]);
  });

  it("always the same output for the same input (determinism)", async () => {
    const hashA = `sha256:${"a".repeat(64)}`;
    const hashB = `sha256:${"b".repeat(64)}`;
    const records = [fixation("sales.trend", hashB), fixation("sales.trend", hashA)];
    const fewShot = createFixationFewShot(storageWith(records));
    const first = await fewShot.examples(INTENT);
    const second = await fewShot.examples(INTENT);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.map((e) => e.intent.canonical)).toEqual(["sales.trend", "sales.trend"]);
  });
});

describe("createFixationFewShot: fixation-list caching (bounded staleness, not a correctness change)", () => {
  /** A StoragePort stub that also counts listFixations() calls. */
  function countingStorage(fixations: FixationRecord[]): { storage: StoragePort; calls: () => number } {
    let calls = 0;
    const storage = {
      ...storageWith(fixations),
      async listFixations() {
        calls += 1;
        return fixations;
      },
    };
    return { storage, calls: () => calls };
  }

  it("within the cache window, repeated examples() calls (even for different intents) do not re-call listFixations()", async () => {
    const { storage, calls } = countingStorage([fixation("sales.trend", `sha256:${"a".repeat(64)}`)]);
    const fewShot = createFixationFewShot(storage, { cacheMs: 10_000 });
    await fewShot.examples(INTENT);
    await fewShot.examples({ ...INTENT, canonical: "sales.other" });
    await fewShot.examples(INTENT);
    expect(calls()).toBe(1);
  });

  it("the sort is cached per canonical: a second call for the same canonical reuses the same sorted result", async () => {
    const hashA = `sha256:${"a".repeat(64)}`;
    const hashB = `sha256:${"b".repeat(64)}`;
    const { storage } = countingStorage([fixation("sales.trend", hashB), fixation("sales.trend", hashA)]);
    const fewShot = createFixationFewShot(storage, { cacheMs: 10_000 });
    const first = await fewShot.examples(INTENT);
    const second = await fewShot.examples(INTENT);
    expect(second).toEqual(first);
  });

  it("once the cache window elapses, the next examples() call refreshes from storage.listFixations()", async () => {
    const { storage, calls } = countingStorage([fixation("sales.trend", `sha256:${"a".repeat(64)}`)]);
    const fewShot = createFixationFewShot(storage, { cacheMs: 10 });
    await fewShot.examples(INTENT);
    expect(calls()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fewShot.examples(INTENT);
    expect(calls()).toBe(2);
  });

  it("a refresh after the window picks up a fixation that was added in the meantime (bounded staleness, not permanently stale)", async () => {
    const fixations: FixationRecord[] = [];
    let calls = 0;
    const storage: StoragePort = {
      ...storageWith(fixations),
      async listFixations() {
        calls += 1;
        return fixations;
      },
    };
    const fewShot = createFixationFewShot(storage, { cacheMs: 10 });
    expect(await fewShot.examples(INTENT)).toEqual([]);
    fixations.push(fixation("sales.trend", `sha256:${"a".repeat(64)}`));
    // Still within the window: the stale (empty) cached list is served.
    expect(await fewShot.examples(INTENT)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Past the window: the newly added fixation is now visible.
    const refreshed = await fewShot.examples(INTENT);
    expect(refreshed).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
