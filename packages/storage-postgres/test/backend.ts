import { dockerAvailable, resolveAdapterBackend } from "@kohaku-ui/port-contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export interface PostgresTestBackend {
  connectionString: string;
  stop(): Promise<void>;
}

export const backend = resolveAdapterBackend("postgres", process.env, dockerAvailable);

export async function startPostgres(): Promise<PostgresTestBackend> {
  if (backend.mode === "url") return { connectionString: backend.url, stop: async () => {} };
  if (backend.mode === "skip") throw new Error(backend.reason);
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  return {
    connectionString: container.getConnectionUri(),
    stop: () => container.stop().then(() => undefined),
  };
}

/** A per-test schema so suites sharing one database (the URL mode) never see each other's rows. */
export function uniqueSchema(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
