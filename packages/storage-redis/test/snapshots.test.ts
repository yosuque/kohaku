import type { FixationRecord, PromotionState, UISpec } from "@kohaku-ui/spec-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

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

describe.skipIf(backend.mode === "skip")("createRedisStoragePort: promotion state / fixation", () => {
  let stop: () => Promise<void>;
  let port: RedisStoragePort;
  beforeAll(async () => {
    const started = await startRedis();
    stop = started.stop;
    port = createRedisStoragePort({ url: started.url, keyPrefix: uniquePrefix() });
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

  it('treats "" the same as undefined for promotion state get/put/list (package-level, beyond the shared contract)', async () => {
    await port.putPromotionState(state("empty-tenant", ""));
    expect(await port.getPromotionState("empty-tenant")).toEqual(state("empty-tenant", ""));
    expect(await port.getPromotionState("empty-tenant", "")).toEqual(state("empty-tenant", ""));
    expect((await port.listPromotionStates("")).map((s) => s.artifactId)).toEqual(
      (await port.listPromotionStates()).map((s) => s.artifactId),
    );
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
});
