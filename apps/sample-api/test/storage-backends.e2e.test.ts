import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { dockerAvailable, resolveAdapterBackend } from "@kohaku-ui/port-contracts";
import type { StoragePort } from "@kohaku-ui/spec-core";
import { createPostgresStoragePort } from "@kohaku-ui/storage-postgres";
import { createRedisStoragePort } from "@kohaku-ui/storage-redis";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// Two independent sample-api instances (two createApp calls = two composer caches' worth of in-process state)
// sharing one Redis / Postgres: the second instance must serve the Intent the first one composed as a cache
// hit. This is the identical-display guarantee across a multi-instance deployment — the sample's file port
// cannot provide it (its Spec cache is per-process), which is the reason these adapters exist.

const QUARTERLY_GUI = {
  input: {
    kind: "gui",
    action: "view.select",
    params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
};

async function compose(app: Hono) {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(QUARTERLY_GUI),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    spec: { intent: { hash: string }; components: unknown[]; provenance: { cache: string } };
  };
}

async function instance(storage: StoragePort) {
  return (await createApp({ llm: new FakeLlm(), storage, authz: createHmacAuthzPort("s") })).app;
}

async function expectSharedCache(a: StoragePort, b: StoragePort) {
  const first = await compose(await instance(a));
  const second = await compose(await instance(b));
  expect(first.spec.provenance.cache).toBe("miss");
  expect(second.spec.provenance.cache).toBe("hit");
  expect(second.spec.intent.hash).toBe(first.spec.intent.hash);
  expect(second.spec.components).toEqual(first.spec.components);
}

const redis = resolveAdapterBackend("redis", process.env, dockerAvailable);
describe.skipIf(redis.mode === "skip")("two sample-api instances on one Redis", () => {
  it("the second instance gets cache:hit for an Intent the first composed", async () => {
    const container = redis.mode === "container" ? await new RedisContainer("redis:7-alpine").start() : null;
    const url = container?.getConnectionUrl() ?? (redis as { url: string }).url;
    const prefix = `e2e${Date.now().toString(36)}`;
    const a = createRedisStoragePort({ url, keyPrefix: prefix });
    const b = createRedisStoragePort({ url, keyPrefix: prefix });
    try {
      await expectSharedCache(a, b);
    } finally {
      await a.close();
      await b.close();
      await container?.stop();
    }
  }, 120_000);
});

const postgres = resolveAdapterBackend("postgres", process.env, dockerAvailable);
describe.skipIf(postgres.mode === "skip")("two sample-api instances on one Postgres", () => {
  it("the second instance gets cache:hit for an Intent the first composed", async () => {
    const container =
      postgres.mode === "container" ? await new PostgreSqlContainer("postgres:16-alpine").start() : null;
    const connectionString = container?.getConnectionUri() ?? (postgres as { url: string }).url;
    const schema = `e2e${Date.now().toString(36)}`;
    const a = createPostgresStoragePort({ connectionString, schema });
    const b = createPostgresStoragePort({ connectionString, schema, migrate: false });
    try {
      await a.ready();
      await expectSharedCache(a, b);
    } finally {
      await a.close();
      await b.close();
      await container?.stop();
    }
  }, 120_000);
});
