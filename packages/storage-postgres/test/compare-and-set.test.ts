import type { FixationRecord, PromotionState, UISpec } from "@kohaku-ui/spec-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStoragePort, type PostgresStoragePort } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

function state(revision: string, status = "candidate"): PromotionState {
  return { artifactId: "a1", status, updatedAt: "2026-01-01T00:00:00.000Z", data: {}, revision };
}
function fixation(revision: string): FixationRecord {
  return {
    intentHash: "h1",
    canonical: "sales.trend",
    structureHash: "sha256:s",
    pinnedSpec: { key: "h1" } as unknown as UISpec,
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "admin" },
    revision,
  };
}

// Two ports on the same database and schema stand in for two host instances (separate pools, no shared
// in-process state): the conditional UPDATE / INSERT ... DO NOTHING / DELETE is the only thing that can make
// exactly one of two writes from the same base win.
describe.skipIf(backend.mode === "skip")(
  "createPostgresStoragePort: compare-and-set across instances",
  () => {
    let stop: () => Promise<void>;
    let connectionString: string;
    let a: PostgresStoragePort;
    let b: PostgresStoragePort;
    beforeAll(async () => {
      const started = await startPostgres();
      stop = started.stop;
      connectionString = started.connectionString;
      const schema = uniqueSchema();
      a = createPostgresStoragePort({ connectionString, schema });
      await a.ready();
      b = createPostgresStoragePort({ connectionString, schema });
      await b.ready();
    });
    afterAll(async () => {
      await a.close();
      await b.close();
      await stop();
    });

    it("lets exactly one of two instances win a promotion write from the same base, every round", async () => {
      for (let round = 0; round < 25; round++) {
        const tenant = `t${round}`;
        const base = { ...state("base"), tenant };
        await a.putPromotionState(base);
        const settled = await Promise.allSettled([
          a.putPromotionState({ ...state(`a${round}`, "approved"), tenant }, { expectedRevision: "base" }),
          b.putPromotionState({ ...state(`b${round}`, "rejected"), tenant }, { expectedRevision: "base" }),
        ]);
        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const loser = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(loser.reason).toMatchObject({ code: "STORAGE_CONFLICT" });
      }
    });

    it("lets exactly one of two instances create a record when both expect it to be absent", async () => {
      for (let round = 0; round < 25; round++) {
        const tenant = `n${round}`;
        const settled = await Promise.allSettled([
          a.putPromotionState({ ...state(`a${round}`), tenant }, { expectedRevision: null }),
          b.putPromotionState({ ...state(`b${round}`), tenant }, { expectedRevision: null }),
        ]);
        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      }
    });

    it("lets a delete and a write from the same base race with exactly one winner", async () => {
      for (let round = 0; round < 25; round++) {
        const tenant = `d${round}`;
        await a.putFixation({ ...fixation("r1"), tenant });
        const settled = await Promise.allSettled([
          a.deleteFixation!("h1", tenant, { expectedRevision: "r1" }),
          b.putFixation({ ...fixation("r2"), tenant }, { expectedRevision: "r1" }),
        ]);
        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      }
    });

    it("keeps the revision predicate working on a payload with no revision key at all", async () => {
      await a.putPromotionState({ artifactId: "legacy", status: "candidate", updatedAt: "x", data: {} });
      await expect(
        b.putPromotionState({ ...state("r2"), artifactId: "legacy" }, { expectedRevision: "r1" }),
      ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
    });
  },
);
