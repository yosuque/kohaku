import type { FixationRecord, PromotionState, UISpec } from "@kohaku-ui/spec-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStoragePort, type PostgresStoragePort } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

function state(artifactId: string, tenant?: string, status = "candidate"): PromotionState {
  return {
    artifactId,
    status,
    updatedAt: "2026-01-01T00:00:00.000Z",
    data: {},
    ...(tenant != null ? { tenant } : {}),
  };
}
function fixation(intentHash: string, tenant?: string, fingerprint = "fp1"): FixationRecord {
  return {
    intentHash,
    canonical: "sales.trend",
    structureHash: "sha256:s",
    pinnedSpec: { key: intentHash } as unknown as UISpec,
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "admin" },
    catalogFingerprint: fingerprint,
    ...(tenant != null ? { tenant } : {}),
  };
}

describe.skipIf(backend.mode === "skip")("createPostgresStoragePort: promotion state / fixation", () => {
  let stop: () => Promise<void>;
  let port: PostgresStoragePort;
  beforeAll(async () => {
    const started = await startPostgres();
    stop = started.stop;
    port = createPostgresStoragePort({ connectionString: started.connectionString, schema: uniqueSchema() });
  });
  afterAll(async () => {
    await port.close();
    await stop();
  });

  it("separates promotion state by (tenant, artifactId); tenant-neutral is only visible without a tenant", async () => {
    await port.putPromotionState(state("a1"));
    await port.putPromotionState(state("a1", "acme", "published"));
    expect((await port.getPromotionState("a1"))?.status).toBe("candidate");
    expect((await port.getPromotionState("a1", "acme"))?.status).toBe("published");
    expect(await port.getPromotionState("a1", "globex")).toBeNull();
    expect((await port.listPromotionStates()).map((s) => [s.artifactId, s.tenant])).toEqual([
      ["a1", undefined],
      ["a1", "acme"],
    ]);
    expect((await port.listPromotionStates("acme")).map((s) => s.status)).toEqual(["published"]);
  });

  it("keeps first-insertion order in lists when a state is overwritten", async () => {
    await port.putPromotionState(state("a2", "acme"));
    await port.putPromotionState(state("a1", "acme", "withdrawn"));
    expect((await port.listPromotionStates("acme")).map((s) => s.artifactId)).toEqual(["a1", "a2"]);
  });

  it("putPromotionStates writes every state in one round trip", async () => {
    await port.putPromotionStates!([state("b1", "globex"), state("b2", "globex")]);
    expect((await port.listPromotionStates("globex")).map((s) => s.artifactId)).toEqual(["b1", "b2"]);
    await port.putPromotionStates!([]); // no-op
  });

  it("separates fixations by (tenant, intentHash) and lists per tenant", async () => {
    await port.putFixation(fixation("h1"));
    await port.putFixation(fixation("h1", "acme"));
    expect((await port.getFixation("h1"))?.tenant).toBeUndefined();
    expect((await port.getFixation("h1", "acme"))?.tenant).toBe("acme");
    expect(await port.getFixation("h1", "globex")).toBeNull();
    expect(await port.listFixations()).toHaveLength(2);
    expect(await port.listFixations("acme")).toHaveLength(1);
  });

  it("putFixation with ifPresent is a no-op when the key is absent, an update when present", async () => {
    await port.putFixation(fixation("h9", "acme"), { ifPresent: true });
    expect(await port.getFixation("h9", "acme")).toBeNull();
    expect(await port.listFixations("acme")).toHaveLength(1);
    await port.putFixation(fixation("h1", "acme", "fp2"), { ifPresent: true });
    expect((await port.getFixation("h1", "acme"))?.catalogFingerprint).toBe("fp2");
  });

  it("deleteFixation removes the record from both indexes", async () => {
    await port.deleteFixation!("h1", "acme");
    expect(await port.getFixation("h1", "acme")).toBeNull();
    expect(await port.listFixations("acme")).toHaveLength(0);
    expect(await port.listFixations()).toHaveLength(1);
    await port.deleteFixation!("h1", "acme"); // idempotent
  });

  it("exposes the optional extensions as functions (a later removal must fail loudly)", () => {
    expect(typeof port.putPromotionStates).toBe("function");
    expect(typeof port.deleteFixation).toBe("function");
  });

  // Regression tests for the `jsonb` key-reordering bug (see schema.ts's comment on why `state` /
  // `record` are `text`): each payload's keys are deliberately out of Postgres jsonb's internal
  // storage order (shortest-length-first, then lexicographic within a length) at both the top level
  // and one level of nesting, so a `jsonb` column would silently reorder them on write and fail these
  // assertions -- `toEqual` (used elsewhere in this file) would not notice, since it ignores key
  // order entirely. `pinnedSpec` is the field that actually broke REST-CMP-002-style determinism:
  // fixate() returns the freshly-composed in-process record, and every subsequent compose re-reads it
  // via getFixation with no in-memory cache in that path, so a reordering here is not just
  // theoretical -- it is delivered to the next caller.
  it("preserves the exact key order of a promotion state round trip", async () => {
    const nonCanonical = state("order-check", "acme");
    (nonCanonical as { data: unknown }).data = { zzz: 1, a: { deep2: true, d: 1 }, bb: "x" };
    await port.putPromotionState(nonCanonical);
    const readBack = await port.getPromotionState("order-check", "acme");
    expect(JSON.stringify(readBack)).toBe(JSON.stringify(nonCanonical));
  });

  it("preserves the exact key order of a fixation round trip (pinnedSpec included)", async () => {
    const nonCanonical = fixation("order-check", "acme");
    (nonCanonical as { pinnedSpec: unknown }).pinnedSpec = { zzz: 1, a: { deep2: true, d: 1 }, bb: "x" };
    await port.putFixation(nonCanonical);
    const readBack = await port.getFixation("order-check", "acme");
    expect(JSON.stringify(readBack)).toBe(JSON.stringify(nonCanonical));
  });
});
