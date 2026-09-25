import { dockerAvailable } from "@kohaku-ui/port-contracts";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

/**
 * Starts at most one Postgres container for the whole `storage-postgres` vitest project run, instead of
 * every test file independently probing Docker and starting its own container (there are 7 files under
 * test/ that each import ./backend). See packages/storage-redis/test/global-setup.ts for the full
 * rationale (identical shape, mirrored per backend).
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  if (process.env.KOHAKU_ADAPTER_TESTS === "skip") return;
  if (process.env.KOHAKU_TEST_POSTGRES_URL) return;
  if (!dockerAvailable()) return;
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  project.provide("kohakuTestPostgresUrl", container.getConnectionUri());
  return () => container.stop().then(() => undefined);
}
