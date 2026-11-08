import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CapabilityRevocationStore,
  FixationRecord,
  LineageEventRecord,
  PromotionState,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type PythonPeer, resolvePythonPeer, runPythonPeer } from "./python-peer.js";

/** What the suite needs of an adapter under test: its StoragePort and revocation store on one namespace. */
export interface InteropHandle {
  storage: StoragePort;
  revocations: CapabilityRevocationStore;
  close(): Promise<void>;
}

export interface StoragePythonInteropOptions {
  backend: "redis" | "postgres";
  /** The backend's URL (resolved lazily, so a container starts only when the suite really runs). */
  url: () => Promise<string>;
  /** A fresh Redis key prefix / Postgres schema. */
  namespace: () => string;
  /** The TS adapters on `namespace`. */
  open: (url: string, namespace: string) => Promise<InteropHandle>;
  /** Skip the whole suite (no backend). */
  skip: boolean;
}

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SPEC = JSON.parse(
  readFileSync(join(REPO_ROOT, "spec", "examples", "quarterly-sales.spec.json"), "utf8"),
) as UISpec;

const TENANT = "acme";
const EVENT_TS = "2026-02-01T00:00:00.000Z";

const tsEvent: LineageEventRecord = {
  id: "ts-event",
  ts: EVENT_TS,
  actor: { kind: "system" },
  type: "view.composed",
  payload: { intentHash: "sha256:interop", correlationId: "ts-corr" },
  tenant: TENANT,
};

function promotion(revision: string, status: string, data: Record<string, unknown> = {}): PromotionState {
  return { artifactId: "a1", status, updatedAt: EVENT_TS, data, tenant: TENANT, revision } as PromotionState;
}

function fixation(revision: string, catalogFingerprint: string): FixationRecord {
  return {
    intentHash: "sha256:interop",
    canonical: "sales.trend",
    structureHash: "sha256:s",
    pinnedSpec: SPEC,
    fixatedAt: EVENT_TS,
    approver: { id: "admin", name: "Ada", roles: ["admin"] },
    catalogFingerprint,
    tenant: TENANT,
    revision,
  };
}

const ids = (events: readonly { id: string }[]): string[] => events.map((e) => e.id);

/**
 * Proves that the TS and the Python adapters of one backend can share it, which is the claim "data-compatible" rests
 * on: each side reads what the other wrote (promotion state, a fixation with a pinned Spec, a Spec cache entry,
 * lineage events and their indexes, a revocation), compare-and-sets the other's records forward from the revision it
 * stamped, and the first side reads the result back. Both directions run, in separate namespaces:
 *
 * 1. TS writes -> Python reads and compare-and-sets -> TS reads back and compare-and-sets again.
 * 2. Python writes -> TS reads and compare-and-sets -> Python verifies.
 *
 * The Python half is `python/kohaku/tests/storage/interop_peer.py`, started once per step with the workspace venv's
 * interpreter (see python-peer.ts for how it is found and when the suite skips).
 */
export function describeStoragePythonInterop(name: string, options: StoragePythonInteropOptions): void {
  describe.skipIf(options.skip)(`${name}: TS and Python adapters share one ${options.backend}`, () => {
    // Resolved once the suite is actually collected (and `require` can make it throw there).
    const peer: PythonPeer = options.skip ? { mode: "skip", reason: "no backend" } : resolvePythonPeer();
    const run = it.skipIf(peer.mode === "skip");

    function runPeer(url: string, namespace: string, command: "adopt" | "seed" | "verify"): Promise<unknown> {
      if (peer.mode === "skip") throw new Error(peer.reason);
      return runPythonPeer(peer, options.backend, url, namespace, command);
    }

    run("TS writes, Python reads and compare-and-sets, TS reads the result back", async () => {
      const url = await options.url();
      const namespace = options.namespace();
      const ts = await options.open(url, namespace);
      try {
        await ts.storage.putPromotionState(
          promotion("ts-1", "candidate", { verdict: { ok: true }, zzz: 1 }),
          {
            expectedRevision: null,
          },
        );
        await ts.storage.putFixation(fixation("ts-1", "fp-ts"), { expectedRevision: null });
        await ts.storage.putSpecCache("ts-spec", SPEC);
        await ts.storage.appendLineage(tsEvent);
        await ts.revocations.revoke("ts-jti", Math.floor(Date.now() / 1000) + 3600);

        const report = (await runPeer(url, namespace, "adopt")) as {
          seen: Record<string, unknown>;
          staleConflict: boolean;
          pageIds: string[];
        };

        // Python read exactly what TS wrote, including the pinned Spec after a trip through its own model.
        expect(report.seen["promotion"]).toEqual(
          promotion("ts-1", "candidate", { verdict: { ok: true }, zzz: 1 }),
        );
        expect(report.seen["fixation"]).toEqual(fixation("ts-1", "fp-ts"));
        expect(report.seen["spec"]).toEqual(SPEC);
        expect(report.seen["tenantPromotions"]).toEqual(["a1"]);
        expect(report.seen["tenantFixations"]).toEqual(["sha256:interop"]);
        expect(report.seen["lineageIds"]).toEqual(["ts-event"]);
        expect(report.seen["lineageByCorrelation"]).toEqual(["ts-event"]);
        expect(report.seen["lineageByTenant"]).toEqual(["ts-event"]);
        expect(report.seen["tsRevoked"]).toBe(true);
        expect(report.staleConflict).toBe(true);
        expect(report.pageIds).toEqual(["ts-event", "py-event"]);

        // TS reads what Python wrote and compare-and-sets from Python's revision.
        const promoted = await ts.storage.getPromotionState("a1", TENANT);
        expect(promoted?.revision).toBe("py-1");
        expect(promoted?.status).toBe("approved");
        expect(promoted?.data).toEqual({ verdict: { ok: true, by: "python" }, zzz: 1 });
        const fixed = await ts.storage.getFixation("sha256:interop", TENANT);
        expect(fixed?.revision).toBe("py-1");
        expect(fixed?.catalogFingerprint).toBe("fp-py");
        expect(fixed?.pinnedSpec).toEqual(SPEC);
        expect(fixed?.approver).toEqual({ id: "admin", name: "Ada", roles: ["admin"] });
        expect(await ts.storage.getSpecCache("py-spec")).toEqual(SPEC);
        expect(ids(await ts.storage.listLineage())).toEqual(["ts-event", "py-event"]);
        expect(ids(await ts.storage.listLineage({ correlationId: "py-corr" }))).toEqual(["py-event"]);
        expect(await ts.revocations.isRevoked("py-jti")).toBe(true);

        await ts.storage.putPromotionState(promotion("ts-2", "published"), { expectedRevision: "py-1" });
        await expect(
          ts.storage.putPromotionState(promotion("ts-3", "rejected"), { expectedRevision: "py-1" }),
        ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
        expect((await ts.storage.getPromotionState("a1", TENANT))?.revision).toBe("ts-2");
      } finally {
        await ts.close();
      }
    });

    run("Python writes, TS reads and compare-and-sets, Python verifies the result", async () => {
      const url = await options.url();
      const namespace = options.namespace();
      await runPeer(url, namespace, "seed");
      const ts = await options.open(url, namespace);
      try {
        const promoted = await ts.storage.getPromotionState("a1", TENANT);
        expect(promoted).toMatchObject({ status: "candidate", revision: "py-0", tenant: TENANT });
        expect(promoted?.data).toEqual({ verdict: { ok: true, by: "python" }, zzz: 1 });
        const fixed = await ts.storage.getFixation("sha256:interop", TENANT);
        expect(fixed?.revision).toBe("py-0");
        expect(fixed?.pinnedSpec).toEqual(SPEC);
        expect(await ts.storage.getSpecCache("py-spec")).toEqual(SPEC);
        expect(ids(await ts.storage.listLineage({ correlationId: "py-corr" }))).toEqual(["py-event"]);
        expect(await ts.revocations.isRevoked("py-jti")).toBe(true);

        await ts.storage.putPromotionState(promotion("ts-1", "approved"), { expectedRevision: "py-0" });
        await ts.storage.putFixation(fixation("ts-1", "fp-ts"), { expectedRevision: "py-0" });
        await expect(
          ts.storage.putFixation(fixation("ts-9", "fp-stale"), { expectedRevision: "py-0" }),
        ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
        await ts.storage.appendLineage(tsEvent);
        await ts.revocations.revoke("ts-jti", Math.floor(Date.now() / 1000) + 3600);
      } finally {
        await ts.close();
      }
      await runPeer(url, namespace, "verify");
    });
  });
}
