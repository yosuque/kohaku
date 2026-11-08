import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromotionState } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStoragePort, createMemoryStoragePort } from "../src/index.js";

function state(revision: string): PromotionState {
  return { artifactId: "a1", status: "candidate", updatedAt: "2026-01-01T00:00:00.000Z", data: {}, revision };
}

describe("the file port's in-process compare behavior", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-cas-two-"));
    dirs.push(dir);
    return dir;
  };

  it("does not declare supportsCompareAndSet but marks itself singleProcess (the memory port declares both)", () => {
    const file = createFileStoragePort(freshDir());
    expect(file.supportsCompareAndSet).toBeUndefined();
    expect(file.singleProcess).toBe(true);
    const memory = createMemoryStoragePort();
    expect(memory.supportsCompareAndSet).toBe(true);
    expect(memory.singleProcess).toBe(true);
  });

  it("two instances on one directory (one process): a write based on a stale in-memory copy is rejected against the disk and refreshes the stale view", async () => {
    const dir = freshDir();
    const a = createFileStoragePort(dir);
    await a.putPromotionState(state("r1"));
    const b = createFileStoragePort(dir); // loads r1 into its own memory
    expect((await b.getPromotionState("a1"))?.revision).toBe("r1");
    await a.putPromotionState(state("r2"), { expectedRevision: "r1" });

    // b's memory still says r1, the disk says r2: the compare decides on the disk.
    await expect(b.putPromotionState(state("r3"), { expectedRevision: "r1" })).rejects.toMatchObject({
      code: "STORAGE_CONFLICT",
    });
    expect((await b.getPromotionState("a1"))?.revision).toBe("r2");
    // This is in-process behavior only: nothing here is atomic across two real processes, which is why the
    // port does not declare the extension.
  });
});
