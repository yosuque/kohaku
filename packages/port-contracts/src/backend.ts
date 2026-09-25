import { spawnSync } from "node:child_process";

/**
 * How a backend-backed test suite (Redis / Postgres) finds its backend. Three tiers, in order:
 *   1. an explicit URL in the environment (`KOHAKU_TEST_REDIS_URL` / `KOHAKU_TEST_POSTGRES_URL`) — what CI
 *      sets when the backend runs as a job service;
 *   2. a Docker daemon — the suite starts a throwaway container via testcontainers;
 *   3. neither — the suite is skipped, so a plain `pnpm test` on a laptop without Docker stays green.
 * `KOHAKU_ADAPTER_TESTS=require` turns tier 3 into a failure, so a CI job that is supposed to exercise the
 * adapters can never pass by silently skipping them. `KOHAKU_ADAPTER_TESTS=skip` is the opposite override:
 * it short-circuits to `{ mode: "skip" }` before either tier 1 or tier 2 is even consulted, so a caller who
 * knows Docker isn't available (or doesn't want the `docker info` probe / container startup cost) never pays
 * for it — this is what lets a globalSetup share one probe across every test file in a project instead of
 * each file probing Docker on its own.
 */
export type AdapterBackendKind = "redis" | "postgres";

export type AdapterBackend =
  | { mode: "url"; url: string }
  | { mode: "container" }
  | { mode: "skip"; reason: string };

const URL_ENV: Record<AdapterBackendKind, string> = {
  redis: "KOHAKU_TEST_REDIS_URL",
  postgres: "KOHAKU_TEST_POSTGRES_URL",
};

export function resolveAdapterBackend(
  kind: AdapterBackendKind,
  env: Record<string, string | undefined>,
  dockerProbe: () => boolean,
): AdapterBackend {
  if (env["KOHAKU_ADAPTER_TESTS"] === "skip") {
    return { mode: "skip", reason: "KOHAKU_ADAPTER_TESTS=skip" };
  }
  const url = env[URL_ENV[kind]];
  if (url != null && url !== "") return { mode: "url", url };
  if (dockerProbe()) return { mode: "container" };
  const reason = `no ${kind} backend: set ${URL_ENV[kind]} or make Docker available (testcontainers)`;
  if (env["KOHAKU_ADAPTER_TESTS"] === "require") {
    throw new Error(`${reason} — KOHAKU_ADAPTER_TESTS=require forbids skipping this suite`);
  }
  return { mode: "skip", reason };
}

/** True when a Docker-compatible daemon answers `docker info` within 5 seconds. */
export function dockerAvailable(): boolean {
  const result = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
  return result.status === 0;
}
