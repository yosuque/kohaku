import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStoragePort, type PostgresStoragePort } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

function ev(id: string, extra: Partial<LineageEventRecord> = {}): LineageEventRecord {
  return {
    id,
    ts: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    actor: { kind: "system" },
    type: "view.composed",
    payload: {},
    ...extra,
  };
}

describe.skipIf(backend.mode === "skip")("createPostgresStoragePort: lineage", () => {
  let stop: () => Promise<void>;
  let port: PostgresStoragePort;

  beforeAll(async () => {
    const started = await startPostgres();
    stop = started.stop;
    port = createPostgresStoragePort({ connectionString: started.connectionString, schema: uniqueSchema() });
    await port.appendLineage(ev("01", { payload: { intentHash: "h1", artifactId: "a1" }, tenant: "acme" }));
    await port.appendLineage(ev("02", { type: "component.generated", payload: { artifactId: "a1" } }));
    await port.appendLineage(ev("03", { payload: { intentHash: "h2", specHash: "s3" }, tenant: "globex" }));
    await port.appendLineage(ev("04", { payload: { intentHash: "h1" }, tenant: "acme" }));
  });
  afterAll(async () => {
    await port.close();
    await stop();
  });

  it("lists everything in append order with no filter", async () => {
    expect((await port.listLineage()).map((e) => e.id)).toEqual(["01", "02", "03", "04"]);
  });

  it("filters by intentHash via its index (append order preserved)", async () => {
    expect((await port.listLineage({ intentHash: "h1" })).map((e) => e.id)).toEqual(["01", "04"]);
  });

  it("filters by artifactId / specHash / tenant / type", async () => {
    expect((await port.listLineage({ artifactId: "a1" })).map((e) => e.id)).toEqual(["01", "02"]);
    expect((await port.listLineage({ specHash: "s3" })).map((e) => e.id)).toEqual(["03"]);
    expect((await port.listLineage({ tenant: "acme" })).map((e) => e.id)).toEqual(["01", "04"]);
    expect((await port.listLineage({ type: ["component.generated"] })).map((e) => e.id)).toEqual(["02"]);
    expect(
      (await port.listLineage({ type: ["component.generated", "view.composed"] })).map((e) => e.id),
    ).toEqual(["01", "02", "03", "04"]);
  });

  it("ANDs an indexed predicate with the remaining ones", async () => {
    expect(await port.listLineage({ intentHash: "h1", tenant: "globex" })).toEqual([]);
    expect(
      (
        await port.listLineage({ tenant: "acme", type: ["view.composed"], since: "2026-01-01T00:00:02.000Z" })
      ).map((e) => e.id),
    ).toEqual(["04"]);
  });

  it("applies until before the tail slice and honours limit (<= 0 is empty)", async () => {
    expect(
      (await port.listLineage({ until: "2026-01-01T00:00:02.000Z", limit: 1 })).map((e) => e.id),
    ).toEqual(["02"]);
    expect(await port.listLineage({ limit: 0 })).toEqual([]);
    expect((await port.listLineage({ limit: 2 })).map((e) => e.id)).toEqual(["03", "04"]);
  });

  it("round-trips the whole record (actor / payload / tenant)", async () => {
    const [first] = await port.listLineage({ intentHash: "h1", limit: 1 });
    expect(first).toEqual(ev("04", { payload: { intentHash: "h1" }, tenant: "acme" }));
  });

  it("returns no rows for an empty type filter (matches the file port's `[].includes` semantics)", async () => {
    expect(await port.listLineage({ type: [] })).toEqual([]);
  });

  // Regression test for the `jsonb` key-reordering bug (see schema.ts's comment on why `record` is
  // `text`): the payload's keys are deliberately out of Postgres jsonb's internal storage order
  // (shortest-length-first, then lexicographic within a length) at both the top level and one level
  // of nesting, so a `jsonb` column would silently reorder them on write and fail this assertion --
  // `toEqual` (used elsewhere in this file) would not notice, since it ignores key order entirely.
  it("preserves the exact key order of a round trip (a jsonb column would silently reorder payload)", async () => {
    const nonCanonical = ev("99", { payload: { zzz: 1, a: { deep2: true, d: 1 }, bb: "x" } });
    await port.appendLineage(nonCanonical);
    const [readBack] = await port.listLineage({ limit: 1 });
    expect(JSON.stringify(readBack)).toBe(JSON.stringify(nonCanonical));
  });
});
