import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { tenantKeyedTable } from "../src/tenant-keyed-table.js";

// A pool configured above READ COMMITTED aborts a conflicting conditional statement with SQLSTATE 40001
// (serialization_failure) instead of letting it match no row. That is the same "another writer got there
// first" outcome and must surface as StorageConflictError (409), not as a raw driver error (500).
function poolFailingWith(code: string | undefined): Pool {
  return {
    async query() {
      throw Object.assign(new Error("could not serialize access due to concurrent update"), {
        ...(code != null ? { code } : {}),
      });
    },
  } as unknown as Pool;
}

describe("tenant-keyed table: SQLSTATE 40001 on the compare-and-set path", () => {
  const record = { artifactId: "a1", revision: "r2" };
  const table = (code: string | undefined) =>
    tenantKeyedTable<typeof record>(poolFailingWith(code), "t", "artifact_id", "state", "promotion");

  it("maps 40001 to StorageConflictError for put (string and null), updateExisting and delete", async () => {
    const t = table("40001");
    await expect(t.put(undefined, "a1", record, "r1")).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
    await expect(t.put(undefined, "a1", record, null)).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
    await expect(t.updateExisting(undefined, "a1", record, "r1")).rejects.toMatchObject({
      code: "STORAGE_CONFLICT",
    });
    await expect(t.delete(undefined, "a1", "r1")).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
  });

  it("leaves any other driver error alone", async () => {
    const t = table("57P01");
    await expect(t.put(undefined, "a1", record, "r1")).rejects.toMatchObject({ code: "57P01" });
    await expect(table(undefined).delete(undefined, "a1", "r1")).rejects.toThrow("could not serialize");
  });
});
