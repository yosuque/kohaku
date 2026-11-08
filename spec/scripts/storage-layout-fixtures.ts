/**
 * The cross-language cases for `@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres` and their Python mirrors
 * `kohaku.storage.redis` / `kohaku.storage.postgres`, kept out of generate-cross-language-fixtures.ts for size. A
 * TS host and a Python host can serve ONE Redis / Postgres, so everything the two adapters must agree on without
 * ever talking to each other is pinned here, and neither implementation can drift without the other's tests failing:
 *
 * - `redis`: the key of every kind of record for a spread of key prefixes and tenants (including the ones
 *   `encodeURIComponent` and urllib's `quote` disagree on), which lineage events contribute which index entries, and
 *   which index a lineage filter reads from.
 * - `postgres`: the DDL script and the correlation DDL for a spread of schema names (quoting, index-name
 *   sanitising and truncation), the schema version, and the digest `kohaku_lineage.correlation_id` stores for an
 *   oversized correlation id.
 * - `rows`: the exact text (`JSON.stringify` of the record) that goes into a Redis value / a Postgres `text` column
 *   for each kind of record.
 *
 * Relative imports (not "@kohaku-ui/storage-redis" / "storage-postgres"), for the same reason as the composer /
 * registry / domain-mcp imports in the generator: the spec package declares no dependency on them. Everything reached
 * here is a pure module (`keys.ts`, the pure half of `lineage.ts`, `schema.ts`): none touches a driver at runtime.
 */
import type { LineageEventRecord, LineageFilter } from "@kohaku-ui/spec-core";
import {
  chooseCandidateIndex,
  indexValues,
  isIndexExhaustive,
} from "../../packages/storage-redis/src/lineage.js";
import { redisKeys, tenantSegment } from "../../packages/storage-redis/src/keys.js";
import {
  correlationColumnValue,
  lineageCorrelationDdl,
  POSTGRES_SCHEMA_VERSION,
  postgresSchemaSql,
} from "../../packages/storage-postgres/src/schema.js";

const PREFIXES = ["kohaku", "app1", "we:ird prefix"];

/** `undefined` = no tenant. The last entries are the ones where encodeURIComponent and urllib's quote differ. */
const TENANTS: (string | undefined)[] = [
  undefined,
  "",
  "acme",
  "acme:eu",
  "%",
  "a/b c%ü!~*()'",
  "日本",
  "\u{1f600}",
];

const SCHEMAS = [
  "public",
  "tenant_a",
  'we"ird',
  "o'brien",
  "Mixed-Case.\u{1f600}",
  "über",
  `s${"x".repeat(80)}`,
];

const CORRELATION_IDS = [
  "c1",
  "a".repeat(256),
  "a".repeat(257),
  `req-${"x".repeat(4096)}`,
  "\u{1f600}".repeat(128),
  "\u{1f600}".repeat(129),
  "ü".repeat(300),
];

function eventOf(
  type: string,
  payload: Record<string, unknown>,
  tenant?: string,
  actor: LineageEventRecord["actor"] = { kind: "system" },
): LineageEventRecord {
  // Key order is the order TS `LineageEventRecordSchema` declares (id, ts, actor, type, payload, tenant).
  return {
    id: `${type}:${tenant ?? "-"}:${JSON.stringify(payload).length}`,
    ts: "2026-01-02T03:04:05.678Z",
    actor,
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

const INDEX_EVENTS: LineageEventRecord[] = [
  eventOf("view.composed", {}),
  eventOf(
    "view.composed",
    { intentHash: "sha256:a", specHash: "sha256:s", correlationId: "c1", artifactId: "a1" },
    "acme",
  ),
  eventOf("component.used", { artifactId: 42, intentHash: null, specHash: ["x"] }, ""),
  eventOf("intent.fixated", { correlationId: "" }, "acme:eu"),
];

const FILTERS: LineageFilter[] = [
  {},
  { limit: 5 },
  { since: "2026", limit: 5 },
  { type: [] },
  { type: ["a"] },
  { type: ["a", "b"] },
  { type: ["a"], tenant: "t" },
  { type: ["a", "b"], since: "2026-01-01" },
  { tenant: "t" },
  { tenant: "" },
  { tenant: "t", until: "2026-01-01" },
  { intentHash: "h" },
  { intentHash: "h", artifactId: "a" },
  { artifactId: "a1", specHash: "s1" },
  { correlationId: "c1", type: ["a"] },
  { specHash: "s", tenant: "t", type: ["a"] },
];

/** The record texts: values chosen to exercise JSON.stringify's escaping and non-ASCII handling. */
const NASTY_STRING = "quote\" back\\slash\n tab\t ctl\u0001 ü 日本 \u{1f600} </script>  ";

export interface StorageLayoutFixtures {
  redis: {
    prefixes: string[];
    keys: {
      prefix: string;
      tenant: string | null;
      tenantSegment: string;
      spec: string;
      promotion: string;
      promotionIndex: string;
      fixation: string;
      fixationIndex: string;
    }[];
    fixedKeys: Record<string, string>;
    indexValues: { event: LineageEventRecord; expected: { field: string; value: string }[] }[];
    candidates: {
      filter: LineageFilter;
      candidate: { field: string; values: string[] } | null;
      exhaustive: boolean | null;
    }[];
  };
  postgres: {
    schemaVersion: number;
    schemas: {
      schema: string;
      sql: string;
      correlation: {
        columnName: string;
        indexName: string;
        addColumnSql: string;
        guardedAddColumnSql: string;
        createIndexSql: string;
        createIndexConcurrentlySql: string;
        dropIndexConcurrentlySql: string;
      };
    }[];
    correlationColumnValues: { input: string; inputUtf16Length: number; expected: string }[];
  };
  rows: {
    lineage: { event: LineageEventRecord; text: string }[];
    promotion: { record: Record<string, unknown>; text: string }[];
    fixation: { record: Record<string, unknown>; text: string }[];
  };
}

export function buildStorageLayoutFixtures(pinnedSpec: unknown): StorageLayoutFixtures {
  const keysDefault = redisKeys();
  const keyCases = PREFIXES.flatMap((prefix) =>
    TENANTS.map((tenant) => {
      const keys = redisKeys(prefix);
      return {
        prefix,
        tenant: tenant ?? null,
        tenantSegment: tenantSegment(tenant),
        spec: keys.spec("k:1"),
        promotion: keys.promotion(tenant, "a1"),
        promotionIndex: keys.promotionIndex(tenant),
        fixation: keys.fixation(tenant, "sha256:ab"),
        fixationIndex: keys.fixationIndex(tenant),
      };
    }),
  );

  const lineageEvents: LineageEventRecord[] = [
    eventOf("view.composed", { intentHash: "sha256:a", correlationId: "c1" }, "acme"),
    eventOf("component.used", {}),
    eventOf("intent.fixated", { note: NASTY_STRING, nested: { zzz: 1, a: [1, 2, { b: null }], bb: true } }, "t"),
    eventOf("action.performed", { n: 1, f: 1.5, neg: -2, big: 9007199254740991 }, undefined, {
      kind: "user",
      id: "u-1",
    }),
    eventOf("component.generated", { artifactId: "a1" }, "acme", { kind: "model", model: "m-1" }),
    eventOf("view.fallback", {}, undefined, { kind: "model", id: "m", model: "claude" }),
  ];

  const promotions: Record<string, unknown>[] = [
    { artifactId: "a1", status: "candidate", updatedAt: "2026-01-01T00:00:00.000Z", data: {} },
    {
      artifactId: "a2",
      status: "approved",
      updatedAt: "2026-01-01T00:00:00.000Z",
      data: { verdict: { ok: true, notes: NASTY_STRING }, zzz: 1, a: { deep2: true, d: 1 } },
      tenant: "acme",
      revision: "r-1",
    },
  ];

  const fixation = (extra: Record<string, unknown>): Record<string, unknown> => ({
    intentHash: "sha256:ab",
    canonical: "sales.trend",
    structureHash: "sha256:s",
    pinnedSpec,
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "admin", name: "Ada", roles: ["admin"] },
    ...extra,
  });
  const fixations: Record<string, unknown>[] = [
    fixation({}),
    fixation({ catalogFingerprint: "fp1", tenant: "acme", revision: "r-9" }),
  ];

  return {
    redis: {
      prefixes: PREFIXES,
      keys: keyCases,
      fixedKeys: {
        lineageSeq: keysDefault.lineage.seq,
        lineageEvents: keysDefault.lineage.events,
        lineageBySeq: keysDefault.lineage.bySeq,
        lineageIndexType: keysDefault.lineage.index("type", "view.composed"),
        promotionSeq: keysDefault.promotionSeq,
        fixationSeq: keysDefault.fixationSeq,
        revoked: keysDefault.revoked("jti-1"),
      },
      indexValues: INDEX_EVENTS.map((event) => ({ event, expected: indexValues(event) })),
      candidates: FILTERS.map((filter) => {
        const candidate = chooseCandidateIndex(filter);
        return {
          filter,
          candidate,
          exhaustive: candidate == null ? null : isIndexExhaustive(filter, candidate),
        };
      }),
    },
    postgres: {
      schemaVersion: POSTGRES_SCHEMA_VERSION,
      schemas: SCHEMAS.map((schema) => ({
        schema,
        sql: postgresSchemaSql(schema),
        correlation: lineageCorrelationDdl(schema),
      })),
      correlationColumnValues: CORRELATION_IDS.map((input) => ({
        input,
        inputUtf16Length: input.length,
        expected: correlationColumnValue(input),
      })),
    },
    rows: {
      lineage: lineageEvents.map((event) => ({ event, text: JSON.stringify(event) })),
      promotion: promotions.map((record) => ({ record, text: JSON.stringify(record) })),
      fixation: fixations.map((record) => ({ record, text: JSON.stringify(record) })),
    },
  };
}
