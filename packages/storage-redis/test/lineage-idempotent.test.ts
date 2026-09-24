import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { redisKeys } from "../src/keys.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

function ev(id: string, intentHash = "h1"): LineageEventRecord {
  return {
    id,
    ts: "2026-01-01T00:00:00.000Z",
    actor: { kind: "system" },
    type: "view.composed",
    payload: { intentHash },
    tenant: "acme",
  };
}

/**
 * `appendLineage`'s atomicity/idempotency, inspected directly against raw Redis state (not just through
 * the port's own `listLineage`, which the shared `describeStoragePortContract` already covers via
 * `contract.test.ts`'s "appending an event with an id that already exists is idempotent"). Verifies the
 * fix for the review finding that the previous HSETNX-then-conditionally-index version could leave the
 * body recorded without its index entries if the process crashed in between: everything now goes through
 * one `MULTI`/`EXEC` block, so a fresh append is always fully indexed and a duplicate leaves every piece
 * (body, `by-seq`, every index) exactly as it was.
 */
describe.skipIf(backend.mode === "skip")(
  "createRedisStoragePort: appendLineage idempotency (raw inspection)",
  () => {
    let stop: () => Promise<void>;
    let port: RedisStoragePort;
    let raw: Redis;
    const prefix = uniquePrefix();
    const keys = redisKeys(prefix);

    beforeAll(async () => {
      const started = await startRedis();
      stop = started.stop;
      port = createRedisStoragePort({ url: started.url, keyPrefix: prefix });
      raw = new Redis(started.url);
    }, 60_000);

    afterAll(async () => {
      await port.close();
      raw.disconnect();
      await stop();
    });

    it("a fresh append is fully indexed: the body, by-seq, and every index entry", async () => {
      await port.appendLineage(ev("e1"));

      expect(await raw.hget(keys.lineage.events, "e1")).toBe(JSON.stringify(ev("e1")));
      expect(await raw.zscore(keys.lineage.bySeq, "e1")).not.toBeNull();
      expect(await raw.zscore(keys.lineage.index("type", "view.composed"), "e1")).not.toBeNull();
      expect(await raw.zscore(keys.lineage.index("tenant", "acme"), "e1")).not.toBeNull();
      expect(await raw.zscore(keys.lineage.index("intentHash", "h1"), "e1")).not.toBeNull();
    });

    it("a duplicate append with the SAME payload (the realistic retry case) is a full no-op", async () => {
      await port.appendLineage(ev("e2"));
      const bodyBefore = await raw.hget(keys.lineage.events, "e2");
      const bySeqScoreBefore = await raw.zscore(keys.lineage.bySeq, "e2");
      const typeScoreBefore = await raw.zscore(keys.lineage.index("type", "view.composed"), "e2");
      const tenantScoreBefore = await raw.zscore(keys.lineage.index("tenant", "acme"), "e2");
      const intentHashScoreBefore = await raw.zscore(keys.lineage.index("intentHash", "h1"), "e2");

      await port.appendLineage(ev("e2")); // identical retry: same id, same payload

      expect(await raw.hget(keys.lineage.events, "e2")).toBe(bodyBefore);
      expect(await raw.zscore(keys.lineage.bySeq, "e2")).toBe(bySeqScoreBefore);
      expect(await raw.zscore(keys.lineage.index("type", "view.composed"), "e2")).toBe(typeScoreBefore);
      expect(await raw.zscore(keys.lineage.index("tenant", "acme"), "e2")).toBe(tenantScoreBefore);
      expect(await raw.zscore(keys.lineage.index("intentHash", "h1"), "e2")).toBe(intentHashScoreBefore);
    });

    it("a duplicate id re-appended with a DIFFERENT payload still never overwrites the stored body", async () => {
      // Not a realistic retry (a retry always resends the same payload) -- this only proves HSETNX's own
      // guarantee holds regardless of what the second call's payload looks like. It does NOT assert
      // anything about that payload's own index entries: see appendLineage's doc comment for the
      // documented, accepted limitation this leaves (a spurious index entry under the new payload's own
      // field values, still pointing at the unchanged, original body).
      await port.appendLineage(ev("e3"));
      const bodyBefore = await raw.hget(keys.lineage.events, "e3");

      await port.appendLineage(ev("e3", "mutated"));

      expect(await raw.hget(keys.lineage.events, "e3")).toBe(bodyBefore);
    });
  },
);
