import { type ReplayFixtures, ReplayLlm } from "@kohaku-ui/evals/replay";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory/memory";
import { createApp, SalesRepo, type SampleApp } from "@kohaku-ui-sample/api/browser";
import { createPlaygroundAuthzPort } from "./authz.js";
import { PLAYGROUND_SEED } from "./seed.js";

/**
 * Fixed clock for the NL-normalization prompt (see `AppDeps.now`'s doc comment on `@kohaku-ui-sample/api`):
 * ReplayLlm looks up a recorded response by the exact prompt text, so the playground must always compose
 * as of this same instant, on every load, or the derived "this quarter"/"FY2026" text drifts from what a
 * fixture was recorded against. u5-3 records fixtures against this same value.
 */
export const PLAYGROUND_NOW = (): Date => new Date("2026-09-01T00:00:00Z");

/**
 * A demo-only secret for `createPlaygroundAuthzPort`. Unlike a real deployment's capability secret, this
 * one has no confidentiality requirement to uphold: the token it signs never leaves the browser tab that
 * issued it (no server ever verifies one signed by a *different* tab/session), so there is nothing an
 * attacker gains by knowing this string in the published source.
 */
const PLAYGROUND_AUTHZ_SECRET = "kohaku-playground-demo-secret";

/**
 * Builds one playground host instance: sample-api's `createApp` (via its `./browser` export — see that
 * package's `browser.ts` for why this has no Node-only dependency) wired with in-memory storage, a
 * WebCrypto-backed AuthzPort, and a replay-only LLM. Called once at page load and again by `reset.ts` on
 * every Reset — each call is a clean slate (fresh storage, fresh lineage, a fresh SalesRepo instance).
 *
 * `fixtures` (default `{}`, i.e. every LLM call misses and throws) lets a caller — today just
 * `test/fetch-shim.test.ts`, later u5-3's recorded fixture set — supply a `ReplayFixtures` object without
 * this module needing to know where fixtures come from.
 */
export async function createPlaygroundHost(fixtures: ReplayFixtures = {}): Promise<SampleApp> {
  return createApp({
    llm: new ReplayLlm(fixtures),
    storage: createMemoryStoragePort(),
    authz: createPlaygroundAuthzPort(PLAYGROUND_AUTHZ_SECRET),
    repo: new SalesRepo(PLAYGROUND_SEED),
    now: PLAYGROUND_NOW,
    // l2Smoke intentionally omitted: no jsdom/node:vm in a real browser (see AppDeps.l2Smoke's doc comment).
    // otel intentionally omitted: no OTel SDK/exporter wiring in this host (see AppDeps.otel's doc comment).
  });
}
