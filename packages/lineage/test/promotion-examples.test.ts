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

  it("narrows by tenant in the storage query (not only after the fact) and joins with four queries", async () => {
    const events = [
      ...reviewed("a-acme", "sales.acme", "2026-07-02T00:00:00.000Z", { tenant: "acme" }),
      ...reviewed("a-acme2", "sales.acme2", "2026-07-03T00:00:00.000Z", { tenant: "acme" }),
      ...reviewed("a-globex", "sales.globex", "2026-07-04T00:00:00.000Z", { tenant: "globex" }),
    ];
    const base = storageOf(events);
    const queries: Array<{ type?: string[]; tenant?: string; limit?: number; artifactId?: string }> = [];
    const storage: StoragePort = {
      ...base,
      async listLineage(filter = {}) {
        queries.push(filter);
        return base.listLineage(filter);
      },
    };
    const examples = await schemaEditExamples(storage, { limit: 5 })({ tenant: "acme" });
    expect(examples.map((e) => e.final.componentType)).toEqual(["sales.acme2", "sales.acme"]);
    expect(examples[0]).toEqual({
      final: draft("sales.acme2"),
      suggestion: draft("sales.acme2Machine"),
      htmlExcerpt: "<div>a-acme2</div>",
    });
    expect(queries).toHaveLength(4);
    expect(queries.map((q) => q.type?.[0]).sort()).toEqual([
      "component.generated",
      "component.schemaEdited",
      "component.schemaProposed",
      "component.schemaSuggested",
    ]);
    for (const q of queries) {
      expect(q.tenant).toBe("acme");
      expect(q.limit).toBe(200);
      expect(q.artifactId).toBeUndefined();
    }
  });

  it("issues the same four queries (no per-artifact lookups) however many cases there are", async () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      reviewed(`a${i}`, `sales.n${i}`, `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    ).flat();
    const base = storageOf(events);
    let count = 0;
    const storage: StoragePort = {
      ...base,
      async listLineage(filter = {}) {
        count++;
        return base.listLineage(filter);
      },
    };
    const examples = await schemaEditExamples(storage, { limit: 10 })({});
    expect(examples).toHaveLength(10);
    expect(count).toBe(4);
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
