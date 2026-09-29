import { createFixations, createLineage, createViewRecorder } from "@kohaku-ui/lineage";
import { CanonicalNameSchema, type Principal } from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type A2uiIngest,
  A2uiIngestError,
  type CreateA2uiIngestOptions,
  createA2uiIngest,
  MAX_COMPONENTS_PER_MESSAGE,
} from "../src/index.js";

const APPROVER: Principal = { id: "reviewer-1", name: "Reviewer" };

/** A minimal, schema-valid v0.9.1 createSurface + updateComponents pair with a single Text root (surface creation — send only once per surfaceId). */
function surfaceMessages(surfaceId: string, text: string): unknown[] {
  return [
    { version: "v0.9.1", createSurface: { surfaceId, catalogId: "https://example.com/catalog.json" } },
    {
      version: "v0.9.1",
      updateComponents: { surfaceId, components: [{ id: "root", component: "Text", text }] },
    },
  ];
}

/** An updateComponents-only message for a surface that already exists (repeat ingests of a live surface). */
function updateMessages(surfaceId: string, text: string): unknown[] {
  return [
    {
      version: "v0.9.1",
      updateComponents: { surfaceId, components: [{ id: "root", component: "Text", text }] },
    },
  ];
}

describe("createA2uiIngest", () => {
  let storage: ReturnType<typeof createMemoryStoragePort>;
  let lineage: ReturnType<typeof createLineage>;
  let ingest: A2uiIngest;

  function makeIngest(overrides: Partial<CreateA2uiIngestOptions> = {}): A2uiIngest {
    return createA2uiIngest({
      storage,
      recorder: createViewRecorder(lineage),
      agentId: "vendor-agent",
      ...overrides,
    });
  }

  beforeEach(() => {
    storage = createMemoryStoragePort();
    lineage = createLineage({ storage });
    ingest = makeIngest();
  });

  it("first ingest of a surface is a cache miss, tier L1, composedBy a2ui-ingest", async () => {
    const outcome = await ingest.ingest(surfaceMessages("srf-1", "Hello"), {
      intent: { canonical: "vendor.demo" },
    });
    expect(outcome.cache).toBe("miss");
    expect(outcome.spec.provenance).toMatchObject({ tier: "L1", composedBy: "a2ui-ingest", cache: "miss" });
    expect(outcome.spec.provenance.model).toBe("a2ui:vendor-agent");
    expect(outcome.losses).toEqual([]);
  });

  it("re-ingesting the identical surface/intent/dataVersion is a cache hit", async () => {
    const meta = { intent: { canonical: "vendor.demo" } };
    const first = await ingest.ingest(surfaceMessages("srf-1", "Hello"), meta);
    expect(first.cache).toBe("miss");
    const second = await ingest.ingest(updateMessages("srf-1", "Hello"), meta);
    expect(second.cache).toBe("hit");
    expect(second.spec.components).toEqual(first.spec.components);
  });

  it("records view.composed on every ingest (tier L1, cache reflects hit/miss)", async () => {
    const meta = { intent: { canonical: "vendor.demo" } };
    await ingest.ingest(surfaceMessages("srf-1", "Hello"), meta);
    await ingest.ingest(updateMessages("srf-1", "Hello"), meta);
    const composed = await storage.listLineage({ type: ["view.composed"] });
    expect(composed).toHaveLength(2);
    expect(composed.map((e) => e.payload["cache"])).toEqual(["miss", "hit"]);
    expect(composed.every((e) => e.payload["tier"] === "L1")).toBe(true);
    expect(composed.every((e) => e.payload["canonical"] === "vendor.demo")).toBe(true);
  });

  it("without an explicit intent, the default canonical is derived from agentId + surfaceId", async () => {
    const outcome = await ingest.ingest(surfaceMessages("Srf One!", "Hi"));
    expect(outcome.spec.intent.canonical).toBe("a2ui.vendor_agent.srf_one");
    expect(outcome.spec.intent.params).toEqual({ agent: "vendor-agent", surfaceId: "Srf One!" });
  });

  it("security: a pathologically long, all-underscore surfaceId slugs quickly (no polynomial-ReDoS) into a CanonicalNameSchema-valid canonical", async () => {
    // A regex-based leading/trailing "_" trim (/^_+|_+$/g — CodeQL js/polynomial-redos) is O(k²) on a run of
    // k "_" not already at the string's true end; 100k would make that hang for a very long time (well past
    // any reasonable test timeout) instead of completing in milliseconds.
    const hugeSurfaceId = "_".repeat(100_000);
    const startedAt = Date.now();
    const outcome = await ingest.ingest(surfaceMessages(hugeSurfaceId, "Hi"));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(CanonicalNameSchema.safeParse(outcome.spec.intent.canonical).success).toBe(true);
  });

  it("drift: the same cache key producing different content is reported via onDrift", async () => {
    const drifts: unknown[] = [];
    const drifting = makeIngest({ onDrift: (ctx) => drifts.push(ctx) });
    const meta = { intent: { canonical: "vendor.same_key" } };
    // Both surfaces have an empty data model, so the default dataVersion (a hash of the data model) is
    // identical for both even though the rendered content differs — a deliberately constructed drift.
    const first = await drifting.ingest(surfaceMessages("srf-drift", "Version A"), meta);
    const second = await drifting.ingest(updateMessages("srf-drift", "Version B"), meta);
    expect(first.cache).toBe("miss");
    expect(drifts).toHaveLength(1);
    // Default cachePolicy is "latest-wins": the fresh (B) content is served and re-cached.
    expect(second.cache).toBe("miss");
    expect(second.spec.components[0]!["props"]).toMatchObject({ markdown: "Version B" });
  });

  it("drift with cachePolicy 'first-wins' keeps serving the originally-cached content", async () => {
    const drifting = makeIngest({ cachePolicy: "first-wins" });
    const meta = { intent: { canonical: "vendor.same_key_fw" } };
    await drifting.ingest(surfaceMessages("srf-drift-fw", "Version A"), meta);
    const second = await drifting.ingest(updateMessages("srf-drift-fw", "Version B"), meta);
    expect(second.cache).toBe("hit");
    expect(second.spec.components[0]!["props"]).toMatchObject({ markdown: "Version A" });
  });

  it("a placeholder fallback is recorded to view.fallback and provenance.fallback", async () => {
    await ingest.ingest(
      [
        {
          version: "v0.9.1",
          createSurface: { surfaceId: "srf-2", catalogId: "https://example.com/catalog.json" },
        },
        {
          version: "v0.9.1",
          updateComponents: { surfaceId: "srf-2", components: [{ id: "root", component: "VendorWidget" }] },
        },
      ],
      { intent: { canonical: "vendor.unknown_widget" } },
    );
    const outcome = ingest.latest("srf-2")!;
    expect(outcome.losses).toEqual([
      { componentId: "root", kind: "unknown-component", detail: expect.any(String) },
    ]);
    expect(outcome.spec.provenance.fallback).toMatchObject({ from: "root", kind: "negotiation" });
    const fallbackEvents = await storage.listLineage({ type: ["view.fallback"] });
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.payload["kind"]).toBe("negotiation");
  });

  it("after several ingests, the (L1-only) fixation proposal logic surfaces the intent as a candidate", async () => {
    const meta = { intent: { canonical: "vendor.frequent" } };
    await ingest.ingest(surfaceMessages("srf-freq", "Same content"), meta);
    await ingest.ingest(updateMessages("srf-freq", "Same content"), meta);
    await ingest.ingest(updateMessages("srf-freq", "Same content"), meta);
    // minDistinctSessions: 0 because this recorder never threads a sessionId (A2UI ingest has no browser-session
    // concept) — this test's point is specifically that aggregateL1Usage picks these events up at all (tier: "L1"),
    // not the session-counting behavior, which is already covered by lineage's own fixation-proposals.test.ts.
    const fixations = createFixations({
      lineage,
      storage,
      policy: { minUses: 3, minDistinctSessions: 0, structuralStability: 0.9 },
    });
    const proposals = await fixations.proposals();
    expect(proposals).toContainEqual(
      expect.objectContaining({ canonical: "vendor.frequent", uses: 3, tier: "L1" }),
    );
  });

  it("fixate() pins the latest outcome; a subsequent ingest then returns cache: fixated", async () => {
    const fixations = createFixations({ lineage, storage });
    const fixating = makeIngest({ fixations });
    const meta = { intent: { canonical: "vendor.pin_me" } };
    await fixating.ingest(surfaceMessages("srf-pin", "Pinned content"), meta);

    const record = await fixating.fixate("srf-pin", APPROVER);
    expect(record.canonical).toBe("vendor.pin_me");

    const after = await fixating.ingest(updateMessages("srf-pin", "Changed after pinning"), meta);
    expect(after.cache).toBe("fixated");
    // The structure served is the pinned one (unaffected by the later "Changed after pinning" content).
    expect(after.spec.components[0]!["props"]).toMatchObject({ markdown: "Pinned content" });
  });

  it("fixate() throws when no `fixations` was configured", async () => {
    await ingest.ingest(surfaceMessages("srf-3", "Hi"), { intent: { canonical: "vendor.no_fixations" } });
    await expect(ingest.fixate("srf-3", APPROVER)).rejects.toThrow(/fixations/);
  });

  it("fixate() throws for a surface with no ingested result yet", async () => {
    const fixations = createFixations({ lineage, storage });
    const fixating = makeIngest({ fixations });
    await expect(fixating.fixate("never-ingested", APPROVER)).rejects.toThrow(/no ingested result/);
  });

  it("a fixated shortcut is served, and recorded in lineage, as tier L0 (SPEC.md section 8)", async () => {
    const fixations = createFixations({ lineage, storage });
    const fixating = makeIngest({ fixations });
    const meta = { intent: { canonical: "vendor.pin_l0" } };
    await fixating.ingest(surfaceMessages("srf-l0", "Pinned"), meta);
    await fixating.fixate("srf-l0", APPROVER);

    const after = await fixating.ingest(updateMessages("srf-l0", "Later"), meta);
    expect(after.spec.provenance).toMatchObject({ tier: "L0", cache: "fixated" });
    const composed = await storage.listLineage({ type: ["view.composed"] });
    const last = composed[composed.length - 1]!;
    expect(last.payload["cache"]).toBe("fixated");
    expect(last.payload["tier"]).toBe("L0");
  });

  it("fixate() refuses a degraded rendering (provenance.fallback) with an A2uiIngestError", async () => {
    const fixations = createFixations({ lineage, storage });
    const fixating = makeIngest({ fixations });
    await fixating.ingest(
      [
        {
          version: "v0.9.1",
          createSurface: { surfaceId: "srf-fb", catalogId: "https://example.com/c.json" },
        },
        {
          version: "v0.9.1",
          updateComponents: { surfaceId: "srf-fb", components: [{ id: "root", component: "VendorWidget" }] },
        },
      ],
      { intent: { canonical: "vendor.no_pin_fallback" } },
    );
    await expect(fixating.fixate("srf-fb", APPROVER)).rejects.toThrow(A2uiIngestError);
    await expect(fixating.fixate("srf-fb", APPROVER)).rejects.toThrow(/degraded rendering/);
    expect(await storage.listFixations()).toEqual([]);
  });

  it("fixate() maps a FixationNotAllowedError from the fixations service to an A2uiIngestError", async () => {
    const refusing = makeIngest({
      fixations: {
        async fixate() {
          const err = new Error("an L2 free-form Spec cannot be fixated");
          err.name = "FixationNotAllowedError";
          throw err;
        },
      },
    });
    await refusing.ingest(surfaceMessages("srf-l2", "Hi"), { intent: { canonical: "vendor.refused" } });
    await expect(refusing.fixate("srf-l2", APPROVER)).rejects.toThrow(A2uiIngestError);
  });

  it("a surface whose only loss is a snapshotted {path} binding is not a fallback and can be fixated", async () => {
    const fixations = createFixations({ lineage, storage });
    const fixating = makeIngest({ fixations });
    await fixating.ingest(
      [
        {
          version: "v0.9.1",
          createSurface: { surfaceId: "srf-bound", catalogId: "https://example.com/c.json" },
        },
        { version: "v0.9.1", updateDataModel: { surfaceId: "srf-bound", path: "/greeting", value: "hello" } },
        {
          version: "v0.9.1",
          updateComponents: {
            surfaceId: "srf-bound",
            components: [{ id: "root", component: "Text", text: { path: "/greeting" } }],
          },
        },
      ],
      { intent: { canonical: "vendor.bound" } },
    );
    const outcome = fixating.latest("srf-bound")!;
    expect(outcome.losses.map((l) => l.kind)).toEqual(["binding-snapshotted"]);
    expect(outcome.spec.provenance.fallback).toBeUndefined();
    expect(await storage.listLineage({ type: ["view.fallback"] })).toEqual([]);
    const record = await fixating.fixate("srf-bound", APPROVER);
    expect(record.canonical).toBe("vendor.bound");
  });

  it("tenant isolation: two tenants sharing the same Intent get independent cache entries", async () => {
    // An explicit shared Intent so the two calls land on the same cache key aside from the tenant segment,
    // isolating exactly what this test is about (tenant scoping of the cache key). Surface state is tenant-
    // scoped too, see "tenant-scoped surface state" below.
    const meta = { intent: { canonical: "vendor.multi_tenant", params: { shared: true } } };
    const forA = await ingest.ingest(surfaceMessages("srf-tenant-a", "Hi"), { ...meta, tenant: "tenant-a" });
    const forB = await ingest.ingest(surfaceMessages("srf-tenant-b", "Hi"), { ...meta, tenant: "tenant-b" });
    expect(forA.cache).toBe("miss");
    expect(forB.cache).toBe("miss"); // not a "hit" off tenant A's cache entry
    const repeatA = await ingest.ingest(updateMessages("srf-tenant-a", "Hi"), {
      ...meta,
      tenant: "tenant-a",
    });
    expect(repeatA.cache).toBe("hit");
  });

  describe("tenant-scoped surface state", () => {
    const meta = (tenant: string) => ({ intent: { canonical: "vendor.tenant_scope" }, tenant });

    it("the same surfaceId under two tenants is two independent surfaces", async () => {
      // Both tenants send createSurface for "shared": were state keyed by surfaceId alone, the second would
      // fail with "already exists" (or, worse, extend the first tenant's surface).
      const forA = await ingest.ingest(surfaceMessages("shared", "A content"), meta("tenant-a"));
      const forB = await ingest.ingest(surfaceMessages("shared", "B content"), meta("tenant-b"));
      expect(forA.spec.components[0]!["props"]).toMatchObject({ markdown: "A content" });
      expect(forB.spec.components[0]!["props"]).toMatchObject({ markdown: "B content" });
      expect(ingest.latest("shared", "tenant-a")).toBe(forA);
      expect(ingest.latest("shared", "tenant-b")).toBe(forB);
      expect(ingest.latest("shared")).toBeUndefined(); // the no-tenant scope is a third, empty one
    });

    it("one tenant cannot extend or delete another tenant's surface", async () => {
      await ingest.ingest(surfaceMessages("shared", "A content"), meta("tenant-a"));
      await expect(ingest.ingest(updateMessages("shared", "B content"), meta("tenant-b"))).rejects.toThrow(
        /unknown surface/,
      );
      await expect(
        ingest.ingest([{ version: "v0.9.1", deleteSurface: { surfaceId: "shared" } }], meta("tenant-b")),
      ).rejects.toThrow(/no longer exists/);
      expect(ingest.latest("shared", "tenant-a")).toBeDefined();
    });

    it("fixate(surfaceId, approver, tenant) pins that tenant's outcome only", async () => {
      const fixations = createFixations({ lineage, storage });
      const fixating = makeIngest({ fixations });
      await fixating.ingest(surfaceMessages("shared", "A content"), meta("tenant-a"));
      await fixating.ingest(surfaceMessages("shared", "B content"), meta("tenant-b"));

      await expect(fixating.fixate("shared", APPROVER)).rejects.toThrow(/no ingested result/);
      const record = await fixating.fixate("shared", APPROVER, "tenant-a");
      expect(record.tenant).toBe("tenant-a");
      expect(record.pinnedSpec.components[0]!["props"]).toMatchObject({ markdown: "A content" });
      expect(await storage.getFixation(record.intentHash, "tenant-b")).toBeNull();
    });
  });

  it("ingest() rejects a batch of messages spanning more than one surfaceId", async () => {
    await expect(
      ingest.ingest([
        ...surfaceMessages("srf-a", "A"),
        { version: "v0.9.1", deleteSurface: { surfaceId: "srf-b" } },
      ]),
    ).rejects.toThrow(/exactly one surface/);
  });

  describe("security: DoS bounds", () => {
    it("maxMessagesPerIngest rejects a single ingest() call with too many messages", async () => {
      const bounded = makeIngest({ maxMessagesPerIngest: 2 });
      await expect(bounded.ingest(surfaceMessages("srf-cap", "Hi"))).resolves.toBeDefined(); // exactly 2, OK
      const tooMany = [...surfaceMessages("srf-cap-2", "Hi"), ...updateMessages("srf-cap-2", "Hi again")];
      expect(tooMany.length).toBe(3);
      await expect(bounded.ingest(tooMany)).rejects.toThrow(/maxMessagesPerIngest/);
    });

    it("maxComponentsPerSurface rejects once a surface's accumulated component count exceeds the cap", async () => {
      const bounded = makeIngest({ maxComponentsPerSurface: 2 });
      // root + 2 more = 3 components, over the cap of 2.
      await expect(
        bounded.ingest([
          {
            version: "v0.9.1",
            createSurface: { surfaceId: "srf-many", catalogId: "https://example.com/c.json" },
          },
          {
            version: "v0.9.1",
            updateComponents: {
              surfaceId: "srf-many",
              components: [
                { id: "root", component: "Column", children: ["a", "b"] },
                { id: "a", component: "Text", text: "A" },
                { id: "b", component: "Text", text: "B" },
              ],
            },
          },
        ]),
      ).rejects.toThrow(/maxComponentsPerSurface/);
    });

    it("maxComponentsPerSurface is checked cumulatively across separate ingest() calls, not just within one", async () => {
      const bounded = makeIngest({ maxComponentsPerSurface: 1 });
      await expect(bounded.ingest(surfaceMessages("srf-grow", "Hi"))).resolves.toBeDefined(); // 1 component (root), OK
      await expect(
        bounded.ingest([
          {
            version: "v0.9.1",
            updateComponents: {
              surfaceId: "srf-grow",
              components: [{ id: "extra", component: "Text", text: "x" }],
            },
          },
        ]),
      ).rejects.toThrow(/maxComponentsPerSurface/);
    });

    it("maxDataModelSizeBytes rejects once the surface's data model grows past the cap", async () => {
      const bounded = makeIngest({ maxDataModelSizeBytes: 64 });
      await expect(bounded.ingest(surfaceMessages("srf-big-data", "Hi"))).resolves.toBeDefined(); // empty data model, OK
      const bigValue = "x".repeat(200);
      await expect(
        bounded.ingest([
          {
            version: "v0.9.1",
            updateDataModel: { surfaceId: "srf-big-data", path: "/blob", value: bigValue },
          },
        ]),
      ).rejects.toThrow(/maxDataModelSizeBytes/);
    });

    it("maxDataModelSizeBytes counts UTF-8 bytes, not UTF-16 code units", async () => {
      const bounded = makeIngest({ maxDataModelSizeBytes: 200 });
      await bounded.ingest(surfaceMessages("srf-utf8", "Hi"));
      // 100 CJK characters: about 111 UTF-16 code units of JSON but about 311 UTF-8 bytes.
      await expect(
        bounded.ingest([
          {
            version: "v0.9.1",
            updateDataModel: { surfaceId: "srf-utf8", path: "/blob", value: "あ".repeat(100) },
          },
        ]),
      ).rejects.toThrow(/maxDataModelSizeBytes/);
      // The same number of ASCII characters fits.
      await expect(
        bounded.ingest([
          {
            version: "v0.9.1",
            updateDataModel: { surfaceId: "srf-utf8", path: "/blob", value: "a".repeat(100) },
          },
        ]),
      ).resolves.toBeDefined();
    });

    it("an over-limit call is rejected without committing anything, and a later small update still succeeds", async () => {
      const bounded = makeIngest({ maxComponentsPerSurface: 10 });
      const meta = { intent: { canonical: "vendor.atomic" } };
      await bounded.ingest(surfaceMessages("srf-atomic", "Hi"), meta);
      const grow = (count: number, prefix: string): unknown[] => [
        {
          version: "v0.9.1",
          updateComponents: {
            surfaceId: "srf-atomic",
            components: Array.from({ length: count }, (_, i) => ({
              id: `${prefix}${i}`,
              component: "Text",
              text: "x",
            })),
          },
        },
      ];
      // 1 (root) + 50 = 51 > 10: rejected, and every further attempt keeps being judged against the
      // still-unchanged 1-component surface rather than the rejected 51.
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(bounded.ingest(grow(50, `over${attempt}_`), meta)).rejects.toThrow(
          /maxComponentsPerSurface/,
        );
      }
      const outcome = await bounded.ingest(grow(2, "ok"), meta);
      expect(outcome.spec.components.map((c) => c.id).sort()).toEqual(["ok0", "ok1", "root"]);
    });

    it("a reducer error mid-batch leaves the surface exactly as it was", async () => {
      const meta = { intent: { canonical: "vendor.atomic_reducer" } };
      await ingest.ingest(surfaceMessages("srf-mid", "Original"), meta);
      await expect(
        ingest.ingest(
          [
            ...updateMessages("srf-mid", "Applied then discarded"),
            // A second createSurface for an existing surface is a reducer error.
            {
              version: "v0.9.1",
              createSurface: { surfaceId: "srf-mid", catalogId: "https://example.com/c.json" },
            },
          ],
          meta,
        ),
      ).rejects.toThrow(/already exists/);
      const outcome = await ingest.ingest(
        [{ version: "v0.9.1", updateDataModel: { surfaceId: "srf-mid", path: "/x", value: 1 } }],
        meta,
      );
      expect(outcome.spec.components[0]!["props"]).toMatchObject({ markdown: "Original" });
    });

    it("the schema caps a single message's components array", async () => {
      const tooMany = Array.from({ length: MAX_COMPONENTS_PER_MESSAGE + 1 }, (_, i) => ({
        id: `c${i}`,
        component: "Text",
        text: "x",
      }));
      await ingest.ingest(surfaceMessages("srf-msgcap", "Hi"));
      await expect(
        ingest.ingest([
          { version: "v0.9.1", updateComponents: { surfaceId: "srf-msgcap", components: tooMany } },
        ]),
      ).rejects.toThrow();
    });

    it("maxSurfaces evicts the least recently ingested surface (state and latest())", async () => {
      const bounded = makeIngest({ maxSurfaces: 2 });
      await bounded.ingest(surfaceMessages("s1", "1"));
      await bounded.ingest(surfaceMessages("s2", "2"));
      await bounded.ingest(updateMessages("s1", "1 again")); // s1 is now the most recent
      await bounded.ingest(surfaceMessages("s3", "3")); // evicts s2
      expect(bounded.latest("s1")).toBeDefined();
      expect(bounded.latest("s2")).toBeUndefined();
      expect(bounded.latest("s3")).toBeDefined();
      await expect(bounded.ingest(updateMessages("s2", "2 again"))).rejects.toThrow(/unknown surface/);
    });

    it("deleteSurface drops the surface's latest() outcome", async () => {
      await ingest.ingest(surfaceMessages("srf-del", "Hi"));
      expect(ingest.latest("srf-del")).toBeDefined();
      await expect(
        ingest.ingest([{ version: "v0.9.1", deleteSurface: { surfaceId: "srf-del" } }]),
      ).rejects.toThrow(/no longer exists/);
      expect(ingest.latest("srf-del")).toBeUndefined();
      // The id is free again: createSurface works instead of failing with "already exists".
      await expect(ingest.ingest(surfaceMessages("srf-del", "Back"))).resolves.toBeDefined();
    });

    it("the default caps are generous enough not to reject ordinary-sized ingests", async () => {
      // No overrides: uses DEFAULT_MAX_MESSAGES_PER_INGEST / DEFAULT_MAX_COMPONENTS_PER_SURFACE /
      // DEFAULT_MAX_DATA_MODEL_SIZE_BYTES, all comfortably above this test's small payload.
      await expect(ingest.ingest(surfaceMessages("srf-default-caps", "Hi"))).resolves.toBeDefined();
    });

    it("a pathologically deep message rejects cleanly through ingest() itself, never an uncaught RangeError", async () => {
      // Built iteratively (a for loop, not recursion) so constructing the fixture never risks the test's
      // own stack; parseInboundA2uiMessage's raw-depth pre-check (schemas.ts) is what actually stops this
      // before zod ever recurses through it, and ingest()'s own try/catch is a second line of defense.
      let deepValue: unknown = "leaf";
      for (let i = 0; i < 100000; i++) deepValue = { n: deepValue };
      await expect(
        ingest.ingest([
          {
            version: "v0.9.1",
            updateDataModel: { surfaceId: "srf-deep", path: "/x", value: deepValue },
          },
        ]),
      ).rejects.toThrow(A2uiIngestError);
    });
  });
});
