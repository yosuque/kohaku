import { dockerAvailable, resolveAdapterBackend } from "@kohaku-ui/port-contracts";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

export interface RedisTestBackend {
  url: string;
  stop(): Promise<void>;
}

/** Resolved once per test file at import time so `describe.skip` can be decided synchronously. */
export const backend = resolveAdapterBackend("redis", process.env, dockerAvailable);

/** Starts (or connects to) the Redis this suite runs against. Only called when `backend.mode !== "skip"`. */
export async function startRedis(): Promise<RedisTestBackend> {
  if (backend.mode === "url") return { url: backend.url, stop: async () => {} };
  if (backend.mode === "skip") throw new Error(backend.reason);
  const container: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  return { url: container.getConnectionUrl(), stop: () => container.stop().then(() => undefined) };
}

/** A per-test key prefix so suites sharing one Redis (the URL mode) never see each other's keys. */
export function uniquePrefix(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
