import { dockerAvailable } from "@kohaku-ui/port-contracts";
import { RedisContainer } from "@testcontainers/redis";
import type { TestProject } from "vitest/node";

/**
 * Starts at most one Redis container for the whole `storage-redis` vitest project run, instead of every
 * test file independently probing Docker and starting its own container (there are 9 files under
 * test/ that each import ./backend). Vitest runs a project's globalSetup exactly once, before any of
 * its test files load, and calling `project.provide()` here hands the container's URL to test files via
 * vitest's inject() (see test/backend.ts) — the vitest-supported channel for this, since a plain
 * `process.env` write here is not guaranteed to reach a worker pool's own environment snapshot.
 *
 * `KOHAKU_ADAPTER_TESTS=skip` and an already-set `KOHAKU_TEST_REDIS_URL` (what CI sets when Redis runs
 * as a job service) both short-circuit before Docker is even probed, so this file never costs anything
 * in those cases. When Docker isn't available either, this is a no-op and every test file's own
 * `resolveAdapterBackend` call resolves to "skip" as before.
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  if (process.env.KOHAKU_ADAPTER_TESTS === "skip") return;
  if (process.env.KOHAKU_TEST_REDIS_URL) return;
  if (!dockerAvailable()) return;
  const container = await new RedisContainer("redis:7-alpine").start();
  project.provide("kohakuTestRedisUrl", container.getConnectionUrl());
  return () => container.stop().then(() => undefined);
}
