import type { UISpec } from "@kohaku-ui/spec-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStoragePort, type PostgresStoragePort } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

function fakeSpec(id: string): UISpec {
  return { key: id } as unknown as UISpec;
}

describe.skipIf(backend.mode === "skip")("createPostgresStoragePort: spec cache", () => {
  let stop: () => Promise<void>;
  let connectionString: string;
  let port: PostgresStoragePort;
  const schema = uniqueSchema();

  beforeAll(async () => {
    const started = await startPostgres();
    connectionString = started.connectionString;
    stop = started.stop;
    port = createPostgresStoragePort({ connectionString, schema });
    await port.ready();
  });
  afterAll(async () => {
    await port.close();
    await stop();
  });

  it("migrates on first use (the tables exist)", async () => {
    const pool = new Pool({ connectionString });
    try {
      const { rows } = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
        [schema],
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        "kohaku_fixation",
        "kohaku_lineage",
        "kohaku_promotion_state",
        "kohaku_spec_cache",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("stores and returns a Spec by key, upserting on repeat, and null for an unknown key", async () => {
    await port.putSpecCache("k1", fakeSpec("k1"));
    await port.putSpecCache("k1", fakeSpec("k1b"));
    expect(await port.getSpecCache("k1")).toEqual(fakeSpec("k1b"));
    expect(await port.getSpecCache("nope")).toBeNull();
  });

  it("treats an expired entry as a miss and sweeps it", async () => {
    await port.putSpecCache("short", fakeSpec("short"), 1);
    const pool = new Pool({ connectionString });
    try {
      await pool.query(
        `UPDATE "${schema}"."kohaku_spec_cache" SET expires_at = now() - interval '1 second' WHERE key = 'short'`,
      );
    } finally {
      await pool.end();
    }
    expect(await port.getSpecCache("short")).toBeNull();
    expect(await port.sweepExpiredSpecCache()).toBe(1);
    expect(await port.sweepExpiredSpecCache()).toBe(0);
  });

  it("is shared across two port instances (multi-instance cache)", async () => {
    const other = createPostgresStoragePort({ connectionString, schema, migrate: false });
    try {
      await port.putSpecCache("shared", fakeSpec("shared"));
      expect(await other.getSpecCache("shared")).toEqual(fakeSpec("shared"));
    } finally {
      await other.close();
    }
  });

  it("close() on an injected pool leaves the pool usable", async () => {
    const pool = new Pool({ connectionString });
    const injected = createPostgresStoragePort({ pool, schema, migrate: false });
    await injected.close();
    expect((await pool.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    await pool.end();
  });
});
