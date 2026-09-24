import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixationRecord, PromotionState, UISpec } from "@kohaku-ui/spec-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createFileStoragePort } from "../src/index.js";

// Recovery behavior when starting up with corrupt or half-written persistence files (storage-port.ts).
// Snapshots (promotions/fixations) are moved aside to .corrupt and then restart in an empty state,
// while lineage.jsonl skips only the corrupt lines and the half-written trailing line and reads the rest.
// Both use a mkdtemp temporary directory, writing real files before running the load.

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-storage-corrupt-"));
  tmpDirs.push(dir);
  return dir;
}

describe("createFileStoragePort: recovery from snapshot corruption (loadJson)", () => {
  it("when promotions.json is corrupted, it is moved aside to .corrupt and restarts empty", async () => {
    const dir = tmpDir();
    // Content that cannot be parsed as JSON (simulating a case cut off mid-write).
    writeFileSync(join(dir, "promotions.json"), "{ this is not valid json");

    // Startup (= load) does not crash with an exception.
    const storage = createFileStoragePort(dir);

    // Corruption is not swallowed; it falls back to an empty state.
    expect(await storage.listPromotionStates()).toEqual([]);

    // The corrupt file is moved aside to .corrupt rather than deleted, so it can be noticed later.
    const backups = readdirSync(dir).filter((f) => /^promotions\.json\..*\.corrupt$/.test(f));
    expect(backups).toHaveLength(1);
  });

  it("when fixations.json is corrupted, it is moved aside to .corrupt and restarts empty", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "fixations.json"), "}{ broken");

    const storage = createFileStoragePort(dir);

    expect(await storage.listFixations()).toEqual([]);
    const backups = readdirSync(dir).filter((f) => /^fixations\.json\..*\.corrupt$/.test(f));
    expect(backups).toHaveLength(1);
  });

  it("a non-existent snapshot is not moved aside and simply starts empty", async () => {
    const dir = tmpDir();
    const storage = createFileStoragePort(dir);
    expect(await storage.listPromotionStates()).toEqual([]);
    expect(await storage.listFixations()).toEqual([]);
    // If the file is merely absent, no .corrupt move-aside happens.
    expect(readdirSync(dir).filter((f) => f.endsWith(".corrupt"))).toEqual([]);
  });

  // D3: `JSON.parse` succeeds on `null` and on an array, but neither is the {key -> record} shape every
  // snapshot file uses. Before the root-shape check, `null` TypeErrors on the caller's `Object.entries` (no
  // graceful .corrupt move-aside — startup crashes) and `[]` silently loads as "empty" without being flagged
  // as corrupted, so a subsequent write-back would drop the file into the wrong shape. Both must be treated
  // exactly like a JSON parse failure.
  it("a `null` JSON root is treated as corrupted (moved aside to .corrupt) instead of throwing at startup", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "promotions.json"), "null");

    expect(() => createFileStoragePort(dir)).not.toThrow();
    const storage = createFileStoragePort(dir);
    expect(storage).toBeDefined();

    const backups = readdirSync(dir).filter((f) => /^promotions\.json\..*\.corrupt$/.test(f));
    expect(backups).toHaveLength(1);
  });

  it("an array JSON root is treated as corrupted (moved aside to .corrupt) instead of silently loading as empty", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "fixations.json"), "[]");

    const storage = createFileStoragePort(dir);
    expect(await storage.listFixations()).toEqual([]);

    const backups = readdirSync(dir).filter((f) => /^fixations\.json\..*\.corrupt$/.test(f));
    expect(backups).toHaveLength(1);
  });

  it("an array JSON root with entries is also treated as corrupted, not partially loaded", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "fixations.json"), JSON.stringify([fixation("sha256:from-array")]));

    const storage = createFileStoragePort(dir);
    expect(await storage.listFixations()).toEqual([]);
    const backups = readdirSync(dir).filter((f) => /^fixations\.json\..*\.corrupt$/.test(f));
    expect(backups).toHaveLength(1);
  });
});

function promoState(artifactId: string): PromotionState {
  return { artifactId, status: "candidate", updatedAt: "2026-01-01T00:00:00.000Z", data: {} };
}

function fixation(intentHash: string): FixationRecord {
  return {
    intentHash,
    canonical: "sales.trend",
    structureHash: "sha256:st",
    pinnedSpec: { key: intentHash } as unknown as UISpec,
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "admin" },
  };
}

// The merge base on runtime corruption (mergePut / mergeDelete).
// If the on-disk snapshot is corrupted during execution, loadJson returns {} after moving it aside to .corrupt,
// but using that as the merge base would collapse all the healthy in-memory state down to that single entry and lose it.
// This pins that on corruption detection the full set is written back using the in-memory Map as the base.
describe("createFileStoragePort: merge base on runtime corruption (mergePut / mergeDelete)", () => {
  it("even if promotions.json is corrupted at runtime, put does not lose existing in-memory entries", async () => {
    const dir = tmpDir();
    const storage = createFileStoragePort(dir);
    await storage.putPromotionState(promoState("art-a"));
    await storage.putPromotionState(promoState("art-b"));

    // Simulate on-disk corruption during execution (the process holds 2 healthy entries in memory).
    writeFileSync(join(dir, "promotions.json"), "{ broken at runtime");

    // Even for a put after corruption, the full set is preserved using the in-memory Map as the base.
    await storage.putPromotionState(promoState("art-c"));
    const ids = (await storage.listPromotionStates()).map((s) => s.artifactId).sort();
    expect(ids).toEqual(["art-a", "art-b", "art-c"]);

    // The full set is also written back to disk (verified by a reload = process restart).
    const reloaded = createFileStoragePort(dir);
    expect((await reloaded.listPromotionStates()).map((s) => s.artifactId).sort()).toEqual([
      "art-a",
      "art-b",
      "art-c",
    ]);

    // The corrupt file is moved aside to .corrupt, so it can be noticed later.
    const backups = readdirSync(dir).filter((f) => /^promotions\.json\..*\.corrupt$/.test(f));
    expect(backups).toHaveLength(1);
  });

  it("even if fixations.json is corrupted at runtime, delete does not lose entries other than the target (mergeDelete)", async () => {
    const dir = tmpDir();
    const storage = createFileStoragePort(dir);
    await storage.putFixation(fixation("sha256:a"));
    await storage.putFixation(fixation("sha256:b"));

    writeFileSync(join(dir, "fixations.json"), "}{ broken at runtime");

    // Even for a delete after corruption, only the target entry is removed and the rest is preserved via the memory base.
    await storage.deleteFixation!("sha256:a");
    expect((await storage.listFixations()).map((f) => f.intentHash)).toEqual(["sha256:b"]);

    const reloaded = createFileStoragePort(dir);
    expect((await reloaded.listFixations()).map((f) => f.intentHash)).toEqual(["sha256:b"]);
  });
});

describe("createFileStoragePort: skip corrupted/partial lines in lineage.jsonl (loadJsonl)", () => {
  it("skips corrupted lines and the trailing partial line, loading only valid lines", async () => {
    const dir = tmpDir();
    const lines = [
      // A normal event (1st).
      JSON.stringify({
        id: "e1",
        ts: "2026-01-01T00:00:00.000Z",
        actor: { kind: "system" },
        type: "view.composed",
        payload: { intentHash: "hA" },
      }),
      // A line corrupted midway (JSON.parse fails -> skipped).
      "{ this line is corrupt",
      // A normal event (2nd).
      JSON.stringify({
        id: "e2",
        ts: "2026-01-02T00:00:00.000Z",
        actor: { kind: "system" },
        type: "view.composed",
        payload: { intentHash: "hB" },
      }),
      // A half-written trailing line from a crash mid-append (incomplete JSON -> parse fails -> skipped.
      // The skip criterion is JSON validity, not the missing newline — see the next test).
      '{"id":"e3","ts":"2026-01-03T00:00:00.000Z","actor":{"kind":"sys',
    ];
    writeFileSync(join(dir, "lineage.jsonl"), lines.join("\n"));

    const storage = createFileStoragePort(dir);

    // The 2 corrupt lines are skipped and only the 2 normal entries are read (order preserved too).
    const events = await storage.listLineage();
    expect(events.map((e) => e.payload["intentHash"])).toEqual(["hA", "hB"]);
  });

  it("a complete JSON line without a trailing newline is kept (skipping is decided by JSON validity, not by the newline)", async () => {
    const dir = tmpDir();
    const lines = [
      JSON.stringify({
        id: "e1",
        ts: "2026-01-01T00:00:00.000Z",
        actor: { kind: "system" },
        type: "view.composed",
        payload: { intentHash: "hA" },
      }),
      JSON.stringify({
        id: "e2",
        ts: "2026-01-02T00:00:00.000Z",
        actor: { kind: "system" },
        type: "view.composed",
        payload: { intentHash: "hB" },
      }),
    ];
    // join without a trailing "\n": the last line is complete JSON but the file ends without a newline.
    writeFileSync(join(dir, "lineage.jsonl"), lines.join("\n"));

    const storage = createFileStoragePort(dir);
    const events = await storage.listLineage();
    expect(events.map((e) => e.payload["intentHash"])).toEqual(["hA", "hB"]);
  });

  it("a file with only blank lines loads as 0 entries (equivalent to not existing)", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "lineage.jsonl"), "\n\n  \n");
    const storage = createFileStoragePort(dir);
    expect(await storage.listLineage()).toEqual([]);
  });

  it("skips JSON-valid but schema-invalid rows (a hand-edited/pre-migration entry) and reports an aggregated skip count", async () => {
    const dir = tmpDir();
    const lines = [
      JSON.stringify({
        id: "e1",
        ts: "2026-01-01T00:00:00.000Z",
        actor: { kind: "system" },
        type: "view.composed",
        payload: { intentHash: "hA" },
      }),
      // Valid JSON but fails LineageEventRecordSchema: actor.kind is not one of "user"/"model"/"system".
      JSON.stringify({
        id: "bad1",
        ts: "2026-01-02T00:00:00.000Z",
        actor: { kind: "robot" },
        type: "view.composed",
        payload: {},
      }),
      // Valid JSON but missing the required `type` field.
      JSON.stringify({
        id: "bad2",
        ts: "2026-01-03T00:00:00.000Z",
        actor: { kind: "system" },
        payload: {},
      }),
      JSON.stringify({
        id: "e2",
        ts: "2026-01-04T00:00:00.000Z",
        actor: { kind: "system" },
        type: "view.composed",
        payload: { intentHash: "hB" },
      }),
    ];
    writeFileSync(join(dir, "lineage.jsonl"), lines.join("\n"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = createFileStoragePort(dir);
      const events = await storage.listLineage();
      // Only the 2 schema-valid entries are read (schema-invalid rows are skipped, same as JSON-parse failures).
      expect(events.map((e) => e.payload["intentHash"])).toEqual(["hA", "hB"]);
      // The 2 skipped rows are reported as one aggregated count, not one warning per row.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("Skipped 2");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
