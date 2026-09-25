import { mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixationRecord, UISpec } from "@kohaku-ui/spec-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createFileStoragePort } from "../src/index.js";

// Isolated in its own file because it mocks node:fs/promises for the whole file (vi.mock is hoisted and applies
// to every test here), which would otherwise interfere with the other storage-port tests' real file I/O.
// Only `rename` is overridden (and only when armed); everything else, including other fs/promises calls this
// module makes internally (readFile/writeFile/unlink/appendFile), goes through the real implementation.
let failNextRename = false;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failNextRename) {
        failNextRename = false;
        throw new Error("simulated rename failure");
      }
      return actual.rename(...args);
    },
  };
});

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

afterEach(() => {
  failNextRename = false;
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-storage-writefail-"));
  tmpDirs.push(dir);
  return dir;
}

function fakeFixation(intentHash: string): FixationRecord {
  return {
    intentHash,
    canonical: "sales.trend",
    structureHash: "sha256:st",
    pinnedSpec: { key: intentHash } as unknown as UISpec,
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "admin" },
  };
}

describe("createFileStoragePort: writeJsonAtomic failure cleanup", () => {
  it("a failed write (rename fails after the tmp file is created) leaves no .tmp file behind", async () => {
    const dir = tmpDir();
    const storage = createFileStoragePort(dir);

    failNextRename = true;
    await expect(storage.putFixation(fakeFixation("sha256:x"))).rejects.toThrow("simulated rename failure");

    // No orphaned tmp file for fixations.json (writeJsonAtomicAsync's try/finally unlinks it on failure).
    const leftovers = readdirSync(dir).filter((f) => f.startsWith("fixations.json.") && f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);

    // The failed write did not corrupt the real file either: a later successful put still works, and the
    // failed entry was never persisted.
    await storage.putFixation(fakeFixation("sha256:y"));
    expect((await storage.listFixations()).map((f) => f.intentHash)).toEqual(["sha256:y"]);
  });
});
