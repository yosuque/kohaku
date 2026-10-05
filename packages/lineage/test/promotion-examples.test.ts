import type { LineageEventRecord, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { schemaEditExamples } from "../src/index.js";

// schemaEditExamples (design.md #73): the extractor's few-shot provider, mined from the lineage log. These
// tests drive it with a hand-rolled StoragePort (lineage may not depend on a storage package), whose
// listLineage honors type / artifactId / tenant / limit like the real ports (a tail window in append order).

function storageOf(events: LineageEventRecord[]): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage(filter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      if (filter.artifactId != null)
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
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

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, ts: string, tenant?: string): LineageEventRecord {
  return {
    id: `ex-${seq++}`,
    ts,
    actor: { kind: "system" },
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

const draft = (componentType: string, description = "d") => ({
  componentType,
  version: "1.0.0",
  intentName: `${componentType.replace(".", ".x_")}`,
  description,
});
const CHANGED = [{ field: "description", suggested: "a", final: "b" }];

/** The four events of one reviewed artifact: generated, suggested, proposed (final), edited. */
function reviewed(
  artifactId: string,
  componentType: string,
  editedAt: string,
  extra: { tenant?: string; changed?: unknown[]; html?: string } = {},
): LineageEventRecord[] {
  const { tenant, changed = CHANGED, html = `<div>${artifactId}</div>` } = extra;
  return [
    ev("component.generated", { artifactId, html }, "2026-07-01T00:00:00.000Z", tenant),
    ev(
      "component.schemaSuggested",
      { artifactId, suggestion: { draft: draft(`${componentType}Machine`), events: [], confidence: 0.5 } },
      "2026-07-01T00:01:00.000Z",
      tenant,
    ),
    ev("component.schemaProposed", { artifactId, draft: draft(componentType) }, editedAt, tenant),
    ev(
      "component.schemaEdited",
      { artifactId, changed, unchanged: [], acknowledged: true },
      editedAt,
      tenant,
    ),
  ];
}

describe("schemaEditExamples", () => {
  it("returns the corrected cases newest first, joined with the final draft, the replaced proposal and the HTML", async () => {
    const provider = schemaEditExamples(
      storageOf([
        ...reviewed("a-old", "sales.old", "2026-07-02T00:00:00.000Z"),
        ...reviewed("a-new", "sales.new", "2026-07-03T00:00:00.000Z"),
      ]),
    );
    const examples = await provider({});
    expect(examples.map((e) => e.final.componentType)).toEqual(["sales.new", "sales.old"]);
    expect(examples[0]).toEqual({
      final: draft("sales.new"),
      suggestion: draft("sales.newMachine"),
      htmlExcerpt: "<div>a-new</div>",
    });
  });

  it("skips an accepted-as-is edit (empty changed) and a case with no final draft", async () => {
    const asIs = reviewed("a-asis", "sales.asIs", "2026-07-05T00:00:00.000Z", { changed: [] });
    const noFinal = reviewed("a-nofinal", "sales.noFinal", "2026-07-04T00:00:00.000Z").filter(
      (e) => e.type !== "component.schemaProposed",
    );
    const good = reviewed("a-good", "sales.good", "2026-07-03T00:00:00.000Z");
    const examples = await schemaEditExamples(storageOf([...good, ...noFinal, ...asIs]))({});
    expect(examples.map((e) => e.final.componentType)).toEqual(["sales.good"]);
  });

  it("limits the result (default 2) after the exclusions, newest cases first", async () => {
    const events = [
      ...reviewed("a1", "sales.one", "2026-07-01T10:00:00.000Z"),
      ...reviewed("a2", "sales.two", "2026-07-02T10:00:00.000Z"),
      ...reviewed("a3", "sales.three", "2026-07-03T10:00:00.000Z", { changed: [] }), // skipped, newest
      ...reviewed("a4", "sales.four", "2026-07-04T10:00:00.000Z"),
    ];
    const storage = storageOf(events);
    expect((await schemaEditExamples(storage)({})).map((e) => e.final.componentType)).toEqual([
      "sales.four",
      "sales.two",
    ]);
    expect((await schemaEditExamples(storage, { limit: 1 })({})).map((e) => e.final.componentType)).toEqual([
      "sales.four",
    ]);
    expect(await schemaEditExamples(storage, { limit: 0 })({})).toEqual([]);
    expect((await schemaEditExamples(storage, { limit: 10 })({})).map((e) => e.final.componentType)).toEqual([
      "sales.four",
      "sales.two",
      "sales.one",
    ]);
  });

  it("uses the latest proposed draft when an artifact was proposed more than once, and one example per artifact", async () => {
    const events = [
      ...reviewed("a1", "sales.first", "2026-07-01T10:00:00.000Z"),
      ev(
        "component.schemaProposed",
        { artifactId: "a1", draft: draft("sales.second") },
        "2026-07-02T09:00:00.000Z",
      ),
      ev(
        "component.schemaEdited",
        { artifactId: "a1", changed: CHANGED, unchanged: [] },
        "2026-07-02T10:00:00.000Z",
      ),
    ];
    const examples = await schemaEditExamples(storageOf(events))({});
    expect(examples).toHaveLength(1);
    expect(examples[0]?.final.componentType).toBe("sales.second");
  });

  it("omits the optional parts that are not recorded, and cuts the HTML to 1500 characters", async () => {
    const events = [
      ev(
        "component.schemaProposed",
        { artifactId: "bare", draft: draft("sales.bare") },
        "2026-07-01T00:00:00.000Z",
      ),
      ev(
        "component.schemaEdited",
        { artifactId: "bare", changed: CHANGED, unchanged: [] },
        "2026-07-01T00:00:01.000Z",
      ),
      ...reviewed("long", "sales.long", "2026-07-02T00:00:00.000Z", { html: `${"x".repeat(1_500)}TAIL` }),
    ];
    const [long, bare] = await schemaEditExamples(storageOf(events))({});
    expect(bare).toEqual({ final: draft("sales.bare") });
    expect(long?.htmlExcerpt).toBe("x".repeat(1_500));
  });

  it("ignores a proposed draft that is not a draft", async () => {
    const events = [
      ev(
        "component.schemaProposed",
        { artifactId: "bad", draft: { componentType: 3 } },
        "2026-07-01T00:00:00.000Z",
      ),
      ev(
        "component.schemaEdited",
        { artifactId: "bad", changed: CHANGED, unchanged: [] },
        "2026-07-01T00:00:01.000Z",
      ),
    ];
    expect(await schemaEditExamples(storageOf(events))({})).toEqual([]);
  });

  it("without a tenant reads only tenant-less records; with a tenant only that tenant's", async () => {
    const events = [
      ...reviewed("a-none", "sales.none", "2026-07-01T00:00:00.000Z"),
      ...reviewed("a-acme", "sales.acme", "2026-07-02T00:00:00.000Z", { tenant: "acme" }),
      ...reviewed("a-globex", "sales.globex", "2026-07-03T00:00:00.000Z", { tenant: "globex" }),
    ];
    const provider = schemaEditExamples(storageOf(events), { limit: 10 });
    const types = async (input: { tenant?: string }) =>
      (await provider(input)).map((e) => e.final.componentType);
    expect(await types({})).toEqual(["sales.none"]);
    expect(await types({ tenant: "acme" })).toEqual(["sales.acme"]);
    expect(await types({ tenant: "globex" })).toEqual(["sales.globex"]);
    // The input decides per call, so one provider serves every tenant without mixing them.
    expect(await types({})).toEqual(["sales.none"]);
  });

  it("treats an empty-string tenant on a record or on the input as no tenant", async () => {
    const events = [
      ...reviewed("a-none", "sales.none", "2026-07-01T00:00:00.000Z"),
      ...reviewed("a-empty", "sales.empty", "2026-07-02T00:00:00.000Z", { tenant: "" }),
      ...reviewed("a-acme", "sales.acme", "2026-07-03T00:00:00.000Z", { tenant: "acme" }),
    ];
    const provider = schemaEditExamples(storageOf(events), { limit: 10 });
    expect((await provider({ tenant: "" })).map((e) => e.final.componentType)).toEqual([
      "sales.empty",
      "sales.none",
    ]);
  });

  /** A storage that records every listLineage filter, over the given events. */
  function recording(events: LineageEventRecord[]): {
    storage: StoragePort;
    queries: Array<{ type?: string[]; tenant?: string; limit?: number; artifactId?: string }>;
  } {
    const base = storageOf(events);
    const queries: Array<{ type?: string[]; tenant?: string; limit?: number; artifactId?: string }> = [];
    return {
      queries,
      storage: {
        ...base,
        async listLineage(filter = {}) {
          queries.push(filter);
          return base.listLineage(filter);
        },
      },
    };
  }

  it("narrows by tenant in every storage query (not only after the fact): one window read, then a lookup per case", async () => {
    const events = [
      ...reviewed("a-acme", "sales.acme", "2026-07-02T00:00:00.000Z", { tenant: "acme" }),
      ...reviewed("a-acme2", "sales.acme2", "2026-07-03T00:00:00.000Z", { tenant: "acme" }),
      ...reviewed("a-globex", "sales.globex", "2026-07-04T00:00:00.000Z", { tenant: "globex" }),
    ];
    const { storage, queries } = recording(events);
    const examples = await schemaEditExamples(storage, { limit: 5 })({ tenant: "acme" });
    expect(examples.map((e) => e.final.componentType)).toEqual(["sales.acme2", "sales.acme"]);
    expect(examples[0]).toEqual({
      final: draft("sales.acme2"),
      suggestion: draft("sales.acme2Machine"),
      htmlExcerpt: "<div>a-acme2</div>",
    });
    // One window read of the edits, then three lookups (proposed, suggested, generated) per case.
    expect(queries).toHaveLength(1 + 2 * 3);
    expect(queries[0]).toMatchObject({ type: ["component.schemaEdited"], limit: 200, tenant: "acme" });
    expect(queries[0]?.artifactId).toBeUndefined();
    for (const q of queries) expect(q.tenant).toBe("acme");
    for (const q of queries.slice(1)) {
      expect(q.limit).toBe(1);
      expect(["a-acme", "a-acme2"]).toContain(q.artifactId);
    }
  });

  it("reads the other three event types only for the artifacts that become examples, never as a 200-record window", async () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      reviewed(`a${i}`, `sales.n${i}`, `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    ).flat();
    const { storage, queries } = recording(events);
    const examples = await schemaEditExamples(storage, { limit: 3 })({});
    expect(examples.map((e) => e.final.componentType)).toEqual(["sales.n11", "sales.n10", "sales.n9"]);
    // 1 window read + (proposed, suggested, generated) for exactly the 3 chosen artifacts: 12 cases cost no more.
    expect(queries).toHaveLength(1 + 3 * 3);
    const lookups = queries.slice(1);
    expect(lookups.every((q) => q.artifactId != null)).toBe(true);
    expect(new Set(lookups.map((q) => q.artifactId))).toEqual(new Set(["a11", "a10", "a9"]));
    // The only unbounded-looking read is the edits window; the HTML (component.generated) is looked up per artifact.
    expect(queries.filter((q) => q.limit === 200).map((q) => q.type)).toEqual([["component.schemaEdited"]]);
  });

  it("returns early after the single edits read when no edit changed a suggestion", async () => {
    const events = [
      ...reviewed("a1", "sales.one", "2026-07-01T00:00:00.000Z", { changed: [] }),
      ...reviewed("a2", "sales.two", "2026-07-02T00:00:00.000Z", { changed: [] }),
    ];
    const { storage, queries } = recording(events);
    expect(await schemaEditExamples(storage)({})).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.type).toEqual(["component.schemaEdited"]);

    const empty = recording([]);
    expect(await schemaEditExamples(empty.storage)({ tenant: "acme" })).toEqual([]);
    expect(empty.queries).toHaveLength(1);
  });

  it("skips a case whose proposal is missing at the cost of one lookup, and fills the limit from the next case", async () => {
    const noFinal = reviewed("a-nofinal", "sales.noFinal", "2026-07-05T00:00:00.000Z").filter(
      (e) => e.type !== "component.schemaProposed",
    );
    const events = [
      ...reviewed("a-good", "sales.good", "2026-07-03T00:00:00.000Z"),
      ...noFinal, // newest edit, no proposal
    ];
    const { storage, queries } = recording(events);
    const examples = await schemaEditExamples(storage, { limit: 1 })({});
    expect(examples.map((e) => e.final.componentType)).toEqual(["sales.good"]);
    // edits window + (proposed for a-nofinal) + (proposed, suggested, generated for a-good)
    expect(queries).toHaveLength(1 + 1 + 3);
  });

  it("without a tenant a per-artifact lookup reads a small window and keeps only tenant-less records", async () => {
    // The same artifactId promoted by two tenants: the newest record of each type belongs to acme.
    const events = [
      ...reviewed("shared", "sales.noTenant", "2026-07-01T00:00:00.000Z"),
      ...reviewed("shared", "sales.acme", "2026-07-02T00:00:00.000Z", { tenant: "acme" }),
    ];
    const { storage, queries } = recording(events);
    const examples = await schemaEditExamples(storage)({});
    expect(examples.map((e) => e.final.componentType)).toEqual(["sales.noTenant"]);
    expect(queries.slice(1).every((q) => (q.limit ?? 0) > 1)).toBe(true);
  });

  it("returns nothing when the extraction was already aborted", async () => {
    const events = reviewed("a1", "sales.one", "2026-07-01T00:00:00.000Z");
    const signal = { aborted: true };
    expect(await schemaEditExamples(storageOf(events))({}, { signal })).toEqual([]);
  });

  it("does not borrow another tenant's proposal for the same artifactId", async () => {
    const events = [
      // acme edited artifact "shared" but its own proposal is missing; globex has one for the same artifactId.
      ev(
        "component.schemaEdited",
        { artifactId: "shared", changed: CHANGED, unchanged: [] },
        "2026-07-02T00:00:01.000Z",
        "acme",
      ),
      ev(
        "component.schemaProposed",
        { artifactId: "shared", draft: draft("sales.globexOnly") },
        "2026-07-02T00:00:00.000Z",
        "globex",
      ),
    ];
    expect(await schemaEditExamples(storageOf(events))({ tenant: "acme" })).toEqual([]);
  });

  it("rejects when the storage fails (the extractor treats that as no examples)", async () => {
    const storage = storageOf([]);
    storage.listLineage = async () => {
      throw new Error("down");
    };
    await expect(schemaEditExamples(storage)({})).rejects.toThrow("down");
  });
});

describe("schemaEditExamples: per-tenant memo", () => {
  function counting(events: LineageEventRecord[]): { storage: StoragePort; reads: () => number } {
    const base = storageOf(events);
    let n = 0;
    return {
      reads: () => n,
      storage: {
        ...base,
        async listLineage(filter = {}) {
          n++;
          return base.listLineage(filter);
        },
      },
    };
  }

  const events = [
    ...reviewed("a-acme", "sales.acme", "2026-07-02T00:00:00.000Z", { tenant: "acme" }),
    ...reviewed("a-globex", "sales.globex", "2026-07-03T00:00:00.000Z", { tenant: "globex" }),
    ...reviewed("a-none", "sales.none", "2026-07-04T00:00:00.000Z"),
  ];

  it("reuses a tenant's result within the TTL, so a batch of candidates reads the log once", async () => {
    const { storage, reads } = counting(events);
    const provider = schemaEditExamples(storage, { now: () => 1_000 });
    const first = await provider({ tenant: "acme" });
    const readsAfterFirst = reads();
    expect(readsAfterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) expect(await provider({ tenant: "acme" })).toEqual(first);
    expect(reads()).toBe(readsAfterFirst);
  });

  it("keys the memo by tenant: another tenant, or no tenant, is not served acme's examples", async () => {
    const { storage } = counting(events);
    const provider = schemaEditExamples(storage, { now: () => 1_000, limit: 10 });
    const types = async (tenant?: string) =>
      (await provider(tenant != null ? { tenant } : {})).map((e) => e.final.componentType);
    expect(await types("acme")).toEqual(["sales.acme"]);
    expect(await types("globex")).toEqual(["sales.globex"]);
    expect(await types()).toEqual(["sales.none"]);
    // An empty tenant is the same scope as none (and shares its entry).
    expect(await types("")).toEqual(["sales.none"]);
    expect(await types("acme")).toEqual(["sales.acme"]);
  });

  it("reads the log again once the TTL has passed, and picks up a newer correction", async () => {
    const live: LineageEventRecord[] = [...reviewed("a1", "sales.one", "2026-07-01T00:00:00.000Z")];
    const { storage, reads } = counting(live);
    let now = 0;
    const provider = schemaEditExamples(storage, { now: () => now, cacheTtlMs: 5_000, limit: 10 });
    expect((await provider({})).map((e) => e.final.componentType)).toEqual(["sales.one"]);
    const afterFirst = reads();

    live.push(...reviewed("a2", "sales.two", "2026-07-02T00:00:00.000Z"));
    now = 4_999; // still inside the TTL: the new correction is not visible yet
    expect((await provider({})).map((e) => e.final.componentType)).toEqual(["sales.one"]);
    expect(reads()).toBe(afterFirst);

    now = 5_000; // the TTL has elapsed
    expect((await provider({})).map((e) => e.final.componentType)).toEqual(["sales.two", "sales.one"]);
    expect(reads()).toBeGreaterThan(afterFirst);
  });

  it("defaults the TTL to 5 seconds", async () => {
    const { storage, reads } = counting(events);
    let now = 100;
    const provider = schemaEditExamples(storage, { now: () => now });
    await provider({ tenant: "acme" });
    const afterFirst = reads();
    now += 4_999;
    await provider({ tenant: "acme" });
    expect(reads()).toBe(afterFirst);
    now += 1;
    await provider({ tenant: "acme" });
    expect(reads()).toBeGreaterThan(afterFirst);
  });

  it("cacheTtlMs: 0 turns the memo off", async () => {
    const { storage, reads } = counting(events);
    const provider = schemaEditExamples(storage, { now: () => 1_000, cacheTtlMs: 0 });
    await provider({ tenant: "acme" });
    const afterFirst = reads();
    await provider({ tenant: "acme" });
    expect(reads()).toBe(afterFirst * 2);
  });

  it("shares one computation between calls that arrive while it is running", async () => {
    const { storage, reads } = counting(events);
    const provider = schemaEditExamples(storage, { now: () => 1_000 });
    const [a, b, c] = await Promise.all([
      provider({ tenant: "acme" }),
      provider({ tenant: "acme" }),
      provider({ tenant: "acme" }),
    ]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const single = counting(events);
    await schemaEditExamples(single.storage, { now: () => 1_000 })({ tenant: "acme" });
    expect(reads()).toBe(single.reads());
  });

  it("does not remember a failure: the next call reads again", async () => {
    const base = storageOf(events);
    let failing = true;
    const storage: StoragePort = {
      ...base,
      async listLineage(filter) {
        if (failing) throw new Error("down");
        return base.listLineage(filter);
      },
    };
    const provider = schemaEditExamples(storage, { now: () => 1_000 });
    await expect(provider({ tenant: "acme" })).rejects.toThrow("down");
    failing = false;
    expect((await provider({ tenant: "acme" })).map((e) => e.final.componentType)).toEqual(["sales.acme"]);
  });

  it("an aborted caller gets nothing without poisoning the shared result for the next one", async () => {
    const { storage } = counting(events);
    const provider = schemaEditExamples(storage, { now: () => 1_000 });
    expect(await provider({ tenant: "acme" }, { signal: { aborted: true } })).toEqual([]);
    expect((await provider({ tenant: "acme" })).map((e) => e.final.componentType)).toEqual(["sales.acme"]);
  });

  it("hands each caller its own array, so one caller cannot change what the next one sees", async () => {
    const { storage } = counting(events);
    const provider = schemaEditExamples(storage, { now: () => 1_000 });
    const first = await provider({ tenant: "acme" });
    first.length = 0;
    expect(await provider({ tenant: "acme" })).toHaveLength(1);
  });
});
