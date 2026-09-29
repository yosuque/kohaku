import {
  type FixationRecord,
  type LineageEventRecord,
  type PromotionState,
  pageLineageArray,
  sha256Hex,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { buildEvidencePack, EVIDENCE_APPROVAL_EVENT_TYPES } from "../src/evidence/build.js";
import type { EvidenceSource } from "../src/evidence/source.js";

const SIGNER = { alg: "Ed25519" as const, keyId: "0123456789abcdef" };
const SCOPE = { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" };

// lineage carries no DOM lib / @types/node dependency (see AGENTS.md); reach TextDecoder structurally,
// the same idiom src/evidence/build.ts and spec-core's canonical-json.ts use for TextEncoder.
const textDecoder = new (
  globalThis as unknown as { TextDecoder: new () => { decode(input: Uint8Array): string } }
).TextDecoder();

function event(
  partial: Partial<LineageEventRecord> & Pick<LineageEventRecord, "id" | "ts" | "type">,
): LineageEventRecord {
  return { actor: { kind: "system" }, payload: {}, ...partial };
}

/** A minimal EvidenceSource over plain in-memory arrays, with a real (non-stubbed) pageLineage built
 * from spec-core's own pageLineageArray so pagination is exercised faithfully. */
function fakeSource(opts: {
  events?: LineageEventRecord[];
  promotions?: PromotionState[];
  fixations?: FixationRecord[];
  paging?: boolean;
}): EvidenceSource {
  const events = opts.events ?? [];
  const promotions = opts.promotions ?? [];
  const fixations = opts.fixations ?? [];
  const source: EvidenceSource = {
    async listLineage(filter) {
      // A deliberately dumb tail-window fallback (mirrors StoragePort.listLineage's contract loosely
      // enough for these tests -- it does not need to be exhaustive, only exercised).
      let result = events;
      if (filter.since != null) result = result.filter((e) => e.ts >= filter.since!);
      if (filter.until != null) result = result.filter((e) => e.ts <= filter.until!);
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      return filter.limit != null ? result.slice(-filter.limit) : result;
    },
    async listPromotionStates(tenant) {
      return tenant == null ? promotions : promotions.filter((p) => p.tenant === tenant);
    },
    async listFixations(tenant) {
      return tenant == null ? fixations : fixations.filter((f) => f.tenant === tenant);
    },
  };
  if (opts.paging !== false) {
    source.pageLineage = async (req) => pageLineageArray(events, req);
  }
  return source;
}

describe("buildEvidencePack", () => {
  it("assembles events/approvals/promotions/fixations and marks the pack complete when paging is available", async () => {
    const events = [
      event({ id: "1", ts: "2026-01-05T00:00:00.000Z", type: "view.composed", payload: { tier: "L1" } }),
      event({
        id: "2",
        ts: "2026-01-06T00:00:00.000Z",
        type: "component.generated",
        payload: { artifactId: "a1", artifactSha256: "will-be-replaced", html: "<div>hello</div>" },
      }),
      event({
        id: "3",
        ts: "2026-01-07T00:00:00.000Z",
        type: "component.reviewed",
        payload: { artifactId: "a1", decision: "approve" },
      }),
      event({
        id: "4",
        ts: "2026-01-08T00:00:00.000Z",
        type: "intent.fixated",
        payload: { intentHash: "h1" },
      }),
      // intent.migrated (F7's catalog migration, design.md #65) is a real LineageEventType member.
      event({
        id: "5",
        ts: "2026-01-09T00:00:00.000Z",
        type: "intent.migrated",
        payload: { intentHash: "h1" },
      }),
    ];
    const realSha = await sha256Hex("<div>hello</div>");
    events[1]!.payload["artifactSha256"] = realSha;

    const promotions: PromotionState[] = [
      { artifactId: "a1", status: "published", updatedAt: "2026-01-07T00:00:00.000Z", data: {} },
    ];
    const fixations: FixationRecord[] = [
      {
        intentHash: "h1",
        canonical: "sales.custom",
        structureHash: "sh1",
        pinnedSpec: { specVersion: "0.1", root: { type: "kohaku:panel", children: [] } } as never,
        fixatedAt: "2026-01-08T00:00:00.000Z",
        approver: { id: "reviewer-1" },
      },
    ];

    const result = await buildEvidencePack({
      source: fakeSource({ events, promotions, fixations }),
      scope: SCOPE,
      generator: "test-generator/1",
      signer: SIGNER,
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(result.manifest.complete).toBe(true);
    expect(result.manifest.generatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.manifest.counts).toEqual({
      events: 5,
      approvals: 3, // component.reviewed + intent.fixated + intent.migrated
      promotions: 1,
      fixations: 1,
      artifacts: 1,
    });
    expect(result.manifest.warnings).toEqual([]);

    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "approvals.jsonl",
      `artifacts/${realSha}.html`,
      "events.jsonl",
      "fixations.jsonl",
      "promotions.jsonl",
    ]);

    const artifactFile = result.files.find((f) => f.path === `artifacts/${realSha}.html`)!;
    expect(textDecoder.decode(artifactFile.content)).toBe("<div>hello</div>");

    const eventsText = textDecoder.decode(result.files.find((f) => f.path === "events.jsonl")!.content);
    expect(eventsText.trim().split("\n")).toHaveLength(5);

    const approvalsText = textDecoder.decode(result.files.find((f) => f.path === "approvals.jsonl")!.content);
    const approvalTypes = approvalsText
      .trim()
      .split("\n")
      .map((line: string) => (JSON.parse(line) as LineageEventRecord).type);
    expect(approvalTypes.sort()).toEqual(["component.reviewed", "intent.fixated", "intent.migrated"]);
    for (const type of approvalTypes) expect(EVIDENCE_APPROVAL_EVENT_TYPES).toContain(type);

    // Every file entry's recorded hash/size matches its actual bytes (independent of sign.ts's own checks).
    for (const entry of result.manifest.files) {
      const file = result.files.find((f) => f.path === entry.path)!;
      expect(file.content.byteLength).toBe(entry.bytes);
      expect(await sha256Hex(textDecoder.decode(file.content))).toBe(entry.sha256);
    }
  });

  it("indexes governed-action decisions and policy changes in approvals.jsonl, but not action.invoked", async () => {
    const types = [
      "action.invoked",
      "action.approvalRequested",
      "action.approved",
      "action.denied",
      "policy.applied",
      "view.composed",
    ] as const;
    const events = types.map((type, i) =>
      event({ id: `e${i}`, ts: `2026-01-0${i + 1}T00:00:00.000Z`, type, payload: {} }),
    );
    const result = await buildEvidencePack({
      source: fakeSource({ events }),
      scope: SCOPE,
      generator: "test-generator/1",
      signer: SIGNER,
    });
    const approvalsText = textDecoder.decode(result.files.find((f) => f.path === "approvals.jsonl")!.content);
    const approvalTypes = approvalsText
      .trim()
      .split("\n")
      .map((line: string) => (JSON.parse(line) as LineageEventRecord).type);
    expect(approvalTypes).toEqual([
      "action.approvalRequested",
      "action.approved",
      "action.denied",
      "policy.applied",
    ]);
    expect(result.manifest.counts.approvals).toBe(4);
    expect(result.manifest.counts.events).toBe(6);
  });

  it("records an artifact hash mismatch as a warning instead of failing the export", async () => {
    const events = [
      event({
        id: "1",
        ts: "2026-01-05T00:00:00.000Z",
        type: "component.generated",
        payload: { artifactId: "a1", artifactSha256: "not-the-real-hash", html: "<div>hi</div>" },
      }),
    ];

    const result = await buildEvidencePack({
      source: fakeSource({ events }),
      scope: SCOPE,
      generator: "test-generator/1",
      signer: SIGNER,
    });

    expect(result.manifest.warnings).toHaveLength(1);
    expect(result.manifest.warnings[0]).toContain("a1");
    expect(result.manifest.warnings[0]).toContain("not-the-real-hash");
    // The artifact is still written, under its *actual* content hash.
    expect(result.manifest.counts.artifacts).toBe(1);
  });

  it("picks up a published artifact's html from promotion state data, not only from lineage events", async () => {
    const html = "<div>from promotion state</div>";
    const realSha = await sha256Hex(html);
    const promotions: PromotionState[] = [
      {
        artifactId: "a2",
        status: "published",
        updatedAt: "2026-01-10T00:00:00.000Z",
        data: { html, sha256: realSha },
      },
    ];

    const result = await buildEvidencePack({
      source: fakeSource({ promotions }),
      scope: SCOPE,
      generator: "test-generator/1",
      signer: SIGNER,
    });

    expect(result.manifest.warnings).toEqual([]);
    expect(result.files.some((f) => f.path === `artifacts/${realSha}.html`)).toBe(true);
  });

  it("throws when the source has no pageLineage and allowIncomplete was not set", async () => {
    await expect(
      buildEvidencePack({
        source: fakeSource({ paging: false }),
        scope: SCOPE,
        generator: "test-generator/1",
        signer: SIGNER,
      }),
    ).rejects.toThrow(/pageLineage/);
  });

  it("falls back to a bounded listLineage tail window and marks the pack incomplete when allowed", async () => {
    const events = [event({ id: "1", ts: "2026-01-05T00:00:00.000Z", type: "view.composed" })];

    const result = await buildEvidencePack({
      source: fakeSource({ events, paging: false }),
      scope: SCOPE,
      generator: "test-generator/1",
      signer: SIGNER,
      allowIncomplete: true,
    });

    expect(result.manifest.complete).toBe(false);
    expect(result.manifest.counts.events).toBe(1);
  });

  it("pages through more events than a single page when the source supports pageLineage", async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      event({
        id: String(i),
        ts: `2026-01-0${i + 1}T00:00:00.000Z`,
        type: "view.composed",
        payload: { seq: i },
      }),
    );

    const result = await buildEvidencePack({
      source: fakeSource({ events }),
      scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
      generator: "test-generator/1",
      signer: SIGNER,
      pageSize: 2,
    });

    expect(result.manifest.complete).toBe(true);
    expect(result.manifest.counts.events).toBe(5);
  });

  it("produces empty (zero-byte) jsonl files when nothing matches the scope", async () => {
    const result = await buildEvidencePack({
      source: fakeSource({}),
      scope: SCOPE,
      generator: "test-generator/1",
      signer: SIGNER,
    });

    expect(result.manifest.counts).toEqual({
      events: 0,
      approvals: 0,
      promotions: 0,
      fixations: 0,
      artifacts: 0,
    });
    for (const name of ["events.jsonl", "approvals.jsonl", "promotions.jsonl", "fixations.jsonl"]) {
      const file = result.files.find((f) => f.path === name)!;
      expect(file.content.byteLength).toBe(0);
    }
  });

  it("fails fast, naming the file and telling the caller to narrow the window, when a file exceeds the per-file cap", async () => {
    const events = [1, 2, 3].map((n) =>
      event({ id: `e${n}`, ts: `2026-01-0${n}T00:00:00.000Z`, type: "view.composed", payload: { n } }),
    );
    const build = (maxFileBytes: number) =>
      buildEvidencePack({
        source: fakeSource({ events }),
        scope: SCOPE,
        generator: "test-generator/1",
        signer: SIGNER,
        maxFileBytes,
      });

    await expect(build(50)).rejects.toThrow(
      /events\.jsonl would be \d+ bytes, over the 50-byte per-file cap/,
    );
    await expect(build(50)).rejects.toThrow(/narrow the export window/);
    // Exactly at the cap is fine: the limit is inclusive, matching verifyEvidencePack's `> cap` refusal.
    const size = (await build(1_000_000)).files.find((f) => f.path === "events.jsonl")!.content.byteLength;
    await expect(build(size)).resolves.toBeDefined();
    await expect(build(size - 1)).rejects.toThrow(/events\.jsonl would be/);
  });

  it("hashes the encoded bytes, not the text (non-ASCII content)", async () => {
    const html = "<div>売上サマリー \u{1F4C8}</div>";
    const result = await buildEvidencePack({
      source: fakeSource({
        events: [
          event({
            id: "e1",
            ts: "2026-01-05T00:00:00.000Z",
            type: "component.generated",
            payload: { artifactId: "a1", html },
          }),
        ],
      }),
      scope: SCOPE,
      generator: "test-generator/1",
      signer: SIGNER,
    });
    for (const entry of result.manifest.files) {
      const file = result.files.find((f) => f.path === entry.path)!;
      expect(entry.sha256).toBe(await sha256Hex(textDecoder.decode(file.content)));
      expect(entry.bytes).toBe(file.content.byteLength);
    }
  });

  it("throws instead of paging forever when pageLineage returns the cursor it was just given", async () => {
    const source = fakeSource({});
    source.pageLineage = async () => ({ events: [], nextCursor: "stuck" });
    await expect(
      buildEvidencePack({ source, scope: SCOPE, generator: "test-generator/1", signer: SIGNER }),
    ).rejects.toThrow(/same nextCursor/);
  });
});
