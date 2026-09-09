import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixationRecord, LineageEventRecord, UISpec } from "@kohaku-ui/spec-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createFileStoragePort } from "../src/ports/storage-port.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// getSpecCache / putSpecCache just store and retrieve the Spec as-is without validating it.
// Since we only want to observe the LRU ordering, use a minimal dummy Spec.
function fakeSpec(id: string): UISpec {
  return { key: id } as unknown as UISpec;
}

function freshStorage() {
  return createFileStoragePort(tmpDir("kohaku-storage-"));
}

describe("createFileStoragePort: specCache TTL expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an entry is evicted and returns null once its ttlSeconds has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = freshStorage();
    await storage.putSpecCache("k", fakeSpec("k"), 1);

    // Still present immediately after the put.
    expect(await storage.getSpecCache("k")).not.toBeNull();

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(await storage.getSpecCache("k")).toBeNull();

    // The entry was actually deleted (not just masked), so a fresh put of the same key succeeds cleanly
    // and is immediately visible.
    await storage.putSpecCache("k", fakeSpec("k-new"));
    expect(await storage.getSpecCache("k")).toEqual(fakeSpec("k-new"));
  });

  it("an entry with no ttlSeconds (expiresAt: null) never expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = freshStorage();
    await storage.putSpecCache("k", fakeSpec("k"));

    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
    expect(await storage.getSpecCache("k")).toEqual(fakeSpec("k"));
  });
});

describe("createFileStoragePort: specCache LRU (cap 500)", () => {
  it("evicts from the oldest key when the entry cap is exceeded", async () => {
    const storage = freshStorage();
    for (let i = 0; i < 500; i++) {
      await storage.putSpecCache(`k${i}`, fakeSpec(`k${i}`));
    }
    // Inserting the 501st entry evicts the oldest key k0.
    await storage.putSpecCache("k500", fakeSpec("k500"));
    expect(await storage.getSpecCache("k0")).toBeNull();
    expect(await storage.getSpecCache("k499")).not.toBeNull();
    expect(await storage.getSpecCache("k500")).not.toBeNull();
  });

  it("a get hit re-inserts, so a recently referenced key is not evicted", async () => {
    const storage = freshStorage();
    for (let i = 0; i < 500; i++) {
      await storage.putSpecCache(`k${i}`, fakeSpec(`k${i}`));
    }
    // Reference k0 to move it to the "recently used" side.
    expect(await storage.getSpecCache("k0")).not.toBeNull();
    // 501st entry -> the oldest is now k1 (k0 has been re-inserted).
    await storage.putSpecCache("k500", fakeSpec("k500"));
    expect(await storage.getSpecCache("k1")).toBeNull();
    expect(await storage.getSpecCache("k0")).not.toBeNull();
  });

  it("put on an existing key does not add duplicates and moves it to the most-recent side", async () => {
    const storage = freshStorage();
    for (let i = 0; i < 500; i++) {
      await storage.putSpecCache(`k${i}`, fakeSpec(`k${i}`));
    }
    // Overwrite k0 (moves it to the newest side). size stays at 500.
    await storage.putSpecCache("k0", fakeSpec("k0-updated"));
    // Add one new entry -> the oldest should now be k1 (k0 was moved to the newest side by the overwrite).
    await storage.putSpecCache("k500", fakeSpec("k500"));
    expect(await storage.getSpecCache("k1")).toBeNull();
    expect(await storage.getSpecCache("k0")).not.toBeNull();
  });
});

function fakeFixation(intentHash: string, tenant?: string): FixationRecord {
  return {
    intentHash,
    canonical: "sales.trend",
    structureHash: "sha256:st",
    pinnedSpec: { key: intentHash } as unknown as UISpec,
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "admin" },
    ...(tenant != null ? { tenant } : {}),
  };
}

function evRecord(type: string, payload: Record<string, unknown>, tenant?: string): LineageEventRecord {
  return {
    id: `${type}:${JSON.stringify(payload)}:${tenant ?? ""}`,
    ts: new Date().toISOString(),
    actor: { kind: "system" },
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

describe("createFileStoragePort: fixation tenant isolation", () => {
  it("get / put / delete are separated by (tenant, intentHash)", async () => {
    const storage = freshStorage();
    const hash = "sha256:" + "1".repeat(64);
    await storage.putFixation(fakeFixation(hash, "acme"));
    await storage.putFixation(fakeFixation(hash, "globex"));
    await storage.putFixation(fakeFixation(hash)); // no tenant

    // Even with the same intentHash, each tenant has a separate record.
    expect((await storage.getFixation(hash, "acme"))?.tenant).toBe("acme");
    expect((await storage.getFixation(hash, "globex"))?.tenant).toBe("globex");
    expect("tenant" in (await storage.getFixation(hash))!).toBe(false);

    // delete only affects the given tenant.
    await storage.deleteFixation!(hash, "acme");
    expect(await storage.getFixation(hash, "acme")).toBeNull();
    expect(await storage.getFixation(hash, "globex")).not.toBeNull();
    expect(await storage.getFixation(hash)).not.toBeNull();
  });

  it("listFixations(tenant) returns only that tenant's entries; unspecified returns all", async () => {
    const storage = freshStorage();
    await storage.putFixation(fakeFixation("sha256:a", "acme"));
    await storage.putFixation(fakeFixation("sha256:b", "globex"));
    await storage.putFixation(fakeFixation("sha256:c")); // no tenant

    expect((await storage.listFixations("acme")).map((f) => f.intentHash)).toEqual(["sha256:a"]);
    expect((await storage.listFixations()).map((f) => f.intentHash).sort()).toEqual([
      "sha256:a",
      "sha256:b",
      "sha256:c",
    ]);
  });

  it("legacy fixations.json (no tenant, intentHash key) loads compatibly as tenant-less", async () => {
    const dir = tmpDir("kohaku-storage-");
    const hash = "sha256:" + "2".repeat(64);
    // Legacy format: key = intentHash, record has no tenant field.
    const legacy = { [hash]: fakeFixation(hash) };
    writeFileSync(join(dir, "fixations.json"), JSON.stringify(legacy, null, 2));
    const storage = createFileStoragePort(dir);

    // Retrievable without a tenant (the composite key is the intentHash itself, so no conversion needed).
    expect((await storage.getFixation(hash))?.intentHash).toBe(hash);
    // Not visible when a tenant is specified (tenant-less records are outside the scope of tenant isolation).
    expect(await storage.getFixation(hash, "acme")).toBeNull();
    // Appears in the full listing (no tenant specified).
    expect((await storage.listFixations()).map((f) => f.intentHash)).toEqual([hash]);
  });

  it("listLineage can filter by tenant (unspecified returns all = legacy behavior)", async () => {
    const storage = freshStorage();
    await storage.appendLineage(evRecord("view.composed", { intentHash: "hA" }, "acme"));
    await storage.appendLineage(evRecord("view.composed", { intentHash: "hB" }, "globex"));
    await storage.appendLineage(evRecord("view.composed", { intentHash: "hC" })); // no tenant

    expect((await storage.listLineage({ tenant: "acme" })).map((e) => e.payload["intentHash"])).toEqual([
      "hA",
    ]);
    expect(await storage.listLineage()).toHaveLength(3);
  });

  it("concurrent putFixation calls for different keys do not lose updates", async () => {
    const dir = tmpDir("kohaku-storage-");
    const storage = createFileStoragePort(dir);
    // Each putFixation does an async read-modify-write against the same fixations.json; without the per-file
    // keyed mutex serializing them, two calls racing on the same read could each write back a snapshot missing
    // the other's entry (a lost update).
    const hashes = Array.from({ length: 20 }, (_, i) => `sha256:${String(i).padStart(4, "0")}`);
    await Promise.all(hashes.map((h) => storage.putFixation(fakeFixation(h))));
    const stored = (await storage.listFixations()).map((f) => f.intentHash).sort();
    expect(stored).toEqual([...hashes].sort());

    // Also verify against a reload from disk (the file itself must hold all 20 entries, not just memory).
    const reloaded = createFileStoragePort(dir);
    expect((await reloaded.listFixations()).map((f) => f.intentHash).sort()).toEqual([...hashes].sort());
  });

  it("listLineage returns an empty array for limit <= 0 (symmetric with Python; prevents slice(-0) returning all. D1)", async () => {
    const storage = freshStorage();
    await storage.appendLineage(evRecord("view.composed", { intentHash: "hA" }));
    await storage.appendLineage(evRecord("view.composed", { intentHash: "hB" }));

    // limit=0: closes the trap where slice(-0) === slice(0) returns all entries, returning an empty array instead.
    expect(await storage.listLineage({ limit: 0 })).toEqual([]);
    // Negative limit is also empty (closes the behavior of returning non-tail entries).
    expect(await storage.listLineage({ limit: -5 })).toEqual([]);
    // Positive limit returns the last `limit` entries.
    expect(await storage.listLineage({ limit: 1 })).toHaveLength(1);
  });
});

describe("createFileStoragePort: putFixation({ ifPresent: true }) does not resurrect a deleted fixation", () => {
  it("across two separate FileStoragePort instances sharing one data dir: A deletes, B's ifPresent-put is a no-op", async () => {
    // Simulates sample-api and sample-mcp sharing one .data directory (§2 review finding): B holds a stale
    // in-memory copy of a fixation that A has since unfixated. B's self-healing refreshFingerprint call
    // (putFixation with ifPresent:true) must not write it back to disk (or resurrect it in either process's
    // memory) once it is no longer present there.
    const dir = tmpDir("kohaku-storage-");
    const hash = "sha256:" + "5".repeat(64);
    const a = createFileStoragePort(dir);
    await a.putFixation(fakeFixation(hash));

    // B loads after A's put, so it also holds the fixation in memory.
    const b = createFileStoragePort(dir);
    expect(await b.getFixation(hash)).not.toBeNull();

    // A deletes it (e.g. a human-approved unfixate, or another process's management-plane action).
    await a.deleteFixation!(hash);
    expect(await a.getFixation(hash)).toBeNull();

    // B's stale in-memory copy attempts to re-stamp the fingerprint via an ifPresent-guarded put — since the
    // key is no longer present in the freshly re-read disk snapshot, the write is a no-op.
    await b.putFixation({ ...fakeFixation(hash), catalogFingerprint: "fp-new" }, { ifPresent: true });

    // Nowhere does the fixation come back: not on disk, not in A's memory, not in B's memory.
    expect(await a.getFixation(hash)).toBeNull();
    expect(await b.getFixation(hash)).toBeNull();
    const reloaded = createFileStoragePort(dir);
    expect(await reloaded.getFixation(hash)).toBeNull();
  });

  it("an ifPresent-put against a key that does exist writes through normally", async () => {
    const storage = freshStorage();
    const hash = "sha256:" + "6".repeat(64);
    await storage.putFixation(fakeFixation(hash));
    await storage.putFixation({ ...fakeFixation(hash), catalogFingerprint: "fp-x" }, { ifPresent: true });
    expect((await storage.getFixation(hash))?.catalogFingerprint).toBe("fp-x");
  });

  it("an ifPresent-put against a key that has never existed is a no-op (does not create it)", async () => {
    const storage = freshStorage();
    const hash = "sha256:" + "7".repeat(64);
    await storage.putFixation(fakeFixation(hash), { ifPresent: true });
    expect(await storage.getFixation(hash)).toBeNull();
  });
});
