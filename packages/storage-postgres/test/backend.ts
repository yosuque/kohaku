import { dockerAvailable, resolveAdapterBackend } from "@kohaku-ui/port-contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    kohakuTestPostgresUrl?: string;
  }
}

export interface PostgresTestBackend {
  connectionString: string;
  stop(): Promise<void>;
}

// global-setup.ts starts one container for the whole project run and provides its URL here via
// vitest's provide/inject. Folding it into the env object resolveAdapterBackend reads means every test
// file in this run lands in the "url" tier and none starts (or probes Docker for) its own container.
const injectedUrl = inject("kohakuTestPostgresUrl");
const env = injectedUrl ? { ...process.env, KOHAKU_TEST_POSTGRES_URL: injectedUrl } : process.env;

export const backend = resolveAdapterBackend("postgres", env, dockerAvailable);

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
