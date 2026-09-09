import type { FixationRecord, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { exportDistillationDataset } from "../src/index.js";

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function makeSpec(intentHash: string, ref: string): UISpec {
  return {
    kohaku: "0.2",
    intent: { canonical: "sales.trend", params: { range: "q3" }, hash: intentHash },
    dataVersion: "ledger@1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["chart"] },
      {
        id: "chart",
        type: "presentChart",
        props: { kind: "line" },
        data: { $ref: ref },
      },
    ],
    events: [{ on: "chart.click", emit: "intent.patch", payload: { drill: "$row.region" } }],
    provenance: { tier: "L1", composedBy: "composer@0.1.0", cache: "hit" },
  };
}

function makeFixation(
  intentHash: string,
  ref: string,
  fixatedAt: string,
  extra: Partial<FixationRecord> = {},
): FixationRecord {
  return {
    intentHash,
    canonical: "sales.trend",
    structureHash: `sha256:${intentHash.slice(7)}`,
    pinnedSpec: makeSpec(intentHash, ref),
    fixatedAt,
    approver: { id: "user-1", name: "Approver" },
    ...extra,
  };
}

describe("exportDistillationDataset", () => {
  it("emits one canonical-JSON line per Spec, sorted by intentHash ascending", () => {
    const fixations = [
      makeFixation(HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z"),
      makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z"),
    ];
    const jsonl = exportDistillationDataset({ fixations });
    const lines = jsonl.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(jsonl.endsWith("\n")).toBe(true);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // sorted ascending: HASH_A before HASH_B
    expect((parsed[0]!["meta"] as { fixatedAt: string }).fixatedAt).toBe("2026-01-01T00:00:00Z");
    expect((parsed[1]!["meta"] as { fixatedAt: string }).fixatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("records only {components, events} under target, excluding kohaku / provenance / dataVersion", () => {
    const jsonl = exportDistillationDataset({
      fixations: [makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")],
    });
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(record["source"]).toBe("fixation");
    expect(record["intent"]).toEqual({ canonical: "sales.trend", params: { range: "q3" } });
    expect(record["refs"]).toEqual(["query://ledger/a"]);
    expect(record["meta"]).toEqual({
      fixatedAt: "2026-01-01T00:00:00Z",
      structureHash: `sha256:${HASH_A.slice(7)}`,
    });
    expect(Object.keys(record)).toEqual(["intent", "meta", "refs", "source", "target"]); // canonical key order (deep-sorted)
    const target = record["target"] as { components: unknown; events: unknown };
    expect(Object.keys(record["target"] as object)).toEqual(["components", "events"]);
    expect((target.components as unknown[]).length).toBe(2);
    expect((target.events as unknown[]).length).toBe(1);
  });

  it("includes golden Specs (source: golden), keyed by spec.intent.hash, with empty meta", () => {
    const golden = [makeSpec(HASH_C, "query://ledger/c")];
    const jsonl = exportDistillationDataset({ fixations: [], golden });
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(record["source"]).toBe("golden");
    expect(record["meta"]).toEqual({});
    expect(record["refs"]).toEqual(["query://ledger/c"]);
  });

  it("interleaves fixation and golden entries in intentHash order", () => {
    const jsonl = exportDistillationDataset({
      fixations: [makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")],
      golden: [makeSpec(HASH_B, "query://ledger/b")],
    });
    const lines = jsonl.split("\n").filter((l) => l !== "");
    const sources = lines.map((l) => (JSON.parse(l) as { source: string }).source);
    expect(sources).toEqual(["fixation", "golden"]);
  });

  it("dedupes $refs across components, preserving first-occurrence order", () => {
    const spec = makeSpec(HASH_A, "query://ledger/a");
    spec.components.push({
      id: "table",
      type: "presentSpreadsheet",
      props: {},
      data: { $ref: "query://ledger/a" },
    });
    spec.components.push({
      id: "chart2",
      type: "presentChart",
      props: {},
      data: { $ref: "query://ledger/z" },
    });
    const jsonl = exportDistillationDataset({ fixations: [], golden: [spec] });
    const record = JSON.parse(jsonl.trim()) as { refs: string[] };
    expect(record.refs).toEqual(["query://ledger/a", "query://ledger/z"]);
  });

  it("adds an optional shape field only when describeShape returns a value", () => {
    const jsonl = exportDistillationDataset(
      { fixations: [makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")] },
      {
        describeShape: (intent) =>
          intent.canonical === "sales.trend" ? [{ name: "region", type: "string" }] : undefined,
      },
    );
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(record["shape"]).toEqual([{ name: "region", type: "string" }]);
  });

  it("omits the shape field when describeShape returns undefined", () => {
    const jsonl = exportDistillationDataset(
      { fixations: [makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")] },
      { describeShape: () => undefined },
    );
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(record["shape"]).toBeUndefined();
  });

  it("returns the empty string for an empty input", () => {
    expect(exportDistillationDataset({ fixations: [] })).toBe("");
  });

  it("is deterministic: re-running the export on the same input reproduces byte-identical output", () => {
    const input = {
      fixations: [
        makeFixation(HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z"),
        makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z"),
      ],
      golden: [makeSpec(HASH_C, "query://ledger/c")],
    };
    expect(exportDistillationDataset(input)).toBe(exportDistillationDataset(input));
  });

  it("populates meta.tenant / meta.catalogFingerprint from the FixationRecord when present", () => {
    const jsonl = exportDistillationDataset({
      fixations: [
        makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z", {
          tenant: "tenant-a",
          catalogFingerprint: "cat-1",
        }),
      ],
    });
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(record["meta"]).toEqual({
      fixatedAt: "2026-01-01T00:00:00Z",
      structureHash: `sha256:${HASH_A.slice(7)}`,
      tenant: "tenant-a",
      catalogFingerprint: "cat-1",
    });
  });

  it("omits meta.tenant / meta.catalogFingerprint when the FixationRecord predates them", () => {
    const jsonl = exportDistillationDataset({
      fixations: [makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")],
    });
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(Object.keys(record["meta"] as object)).toEqual(["fixatedAt", "structureHash"]);
  });

  it("keeps meta empty for golden entries even though a fixation exists for the same intentHash", () => {
    const jsonl = exportDistillationDataset({
      fixations: [],
      golden: [makeSpec(HASH_A, "query://ledger/a")],
    });
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(record["meta"]).toEqual({});
  });

  it("filters fixations to options.tenant, leaving golden entries untouched", () => {
    const jsonl = exportDistillationDataset(
      {
        fixations: [
          makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z", { tenant: "tenant-a" }),
          makeFixation(HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z", { tenant: "tenant-b" }),
        ],
        golden: [makeSpec(HASH_C, "query://ledger/c")],
      },
      { tenant: "tenant-a" },
    );
    const lines = jsonl.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    const records = lines.map((l) => JSON.parse(l) as { source: string; meta: { tenant?: string } });
    expect(records.map((r) => r.source)).toEqual(["fixation", "golden"]);
    expect(records[0]!.meta.tenant).toBe("tenant-a");
  });

  it("without options.tenant, every tenant present in the fixations is included", () => {
    const jsonl = exportDistillationDataset({
      fixations: [
        makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z", { tenant: "tenant-a" }),
        makeFixation(HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z", { tenant: "tenant-b" }),
      ],
    });
    const lines = jsonl.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
  });

  it("breaks a same-intentHash tie by ordering the fixation entry before the golden entry", () => {
    // Same intentHash on both sides so the sort key alone cannot order them: the tie-break must be explicit.
    const jsonl = exportDistillationDataset({
      fixations: [makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")],
      golden: [makeSpec(HASH_A, "query://ledger/a")],
    });
    const lines = jsonl.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    const sources = lines.map((l) => (JSON.parse(l) as { source: string }).source);
    expect(sources).toEqual(["fixation", "golden"]);
  });

  it("projects shape entries to exactly {name, type?, description?}, dropping any other structural keys", () => {
    const jsonl = exportDistillationDataset(
      { fixations: [makeFixation(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z")] },
      {
        describeShape: () => [
          // A ColumnMeta-typed value that structurally carries an extra field (e.g. from a domain's own
          // resultShape type) must not leak that field into the dataset.
          { name: "region", type: "string", nullable: true } as unknown as { name: string; type?: string },
        ],
      },
    );
    const record = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(record["shape"]).toEqual([{ name: "region", type: "string" }]);
  });
});
