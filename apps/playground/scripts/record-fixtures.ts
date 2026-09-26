/**
 * Records real-LLM responses for every `requiresFixtures: true` scenario (`../src/scenarios.ts`) into
 * `../fixtures/<scenario.id>.json`, so the playground's `ReplayLlm` can replay them offline.
 *
 * **This script has never been run.** Recording with a real LLM was deliberately postponed by the user on
 * 2026-09-27 (see `reports/u5-3.md`) — writing it was in scope for u5-3, running it was not. Treat it as
 * reviewed-but-unverified: the API calls it makes (compose, then, for a `promotion` scenario, list + approve)
 * are believed correct from reading `packages/host-rest/src/routes/{compose,promotions}.ts`, but nothing has
 * actually exercised this file end to end. Re-check it against those routes before the first real run.
 *
 * Usage (once actually run): pick any LlmPort @kohaku-ui/llm's `createLlmFromEnv()` can build, e.g.
 *   KOHAKU_LLM_PROVIDER=ollama KOHAKU_LLM_MODEL=gemma4:e4b pnpm --filter @kohaku-ui-sample/playground run record-fixtures
 * Re-run it (for every affected scenario id, not just the changed one — see the module doc below on why)
 * whenever a prompt that could affect one of these scenarios changes: `apps/sample-api/src/{design-system,fewshot}.ts`,
 * `intents/{catalog,fixed-specs}.ts`, `ports/semantic-port.ts`, or `@kohaku-ui/composer`'s own prompt-building.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureLlm } from "@kohaku-ui/evals";
import type { LlmPort } from "@kohaku-ui/llm";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { createL2Smoke } from "@kohaku-ui/sandbox/smoke";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory/memory";
import { createApp, SalesRepo } from "@kohaku-ui-sample/api/browser";
import { createPlaygroundAuthzPort } from "../src/host/authz.js";
import { PLAYGROUND_NOW } from "../src/host/create-host.js";
import { PLAYGROUND_SEED } from "../src/host/seed.js";
import type { Scenario } from "../src/scenarios.js";
import { SCENARIOS } from "../src/scenarios.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const BASE_URL = "http://record-fixtures.local";

/** A demo-only secret — same rationale as create-host.ts's `PLAYGROUND_AUTHZ_SECRET`: it never needs to
 * verify anything issued by the real playground, or vice versa. */
const RECORD_AUTHZ_SECRET = "kohaku-playground-record-fixtures-secret";

function composeRequest(input: Scenario["input"]): Request {
  return new Request(`${BASE_URL}/api/kohaku/compose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
}

/**
 * Approves the promotion candidate matching `requestText`, which is what actually invokes the judge's LLM
 * call (see `apps/sample-api/src/app/promotions.ts`'s `judge:` callback — approval, not listing, is when it
 * fires). Assumes exactly one candidate carries this request text; the seed/scenario list is small enough
 * that this should hold, but re-check it once real fixtures are being recorded for the first time.
 */
async function approveMatchingCandidate(
  app: { fetch(request: Request): Promise<Response> | Response },
  requestText: string,
  scenario: Scenario,
): Promise<void> {
  const listRes = await app.fetch(new Request(`${BASE_URL}/api/kohaku/promotions`));
  if (!listRes.ok) {
    throw new Error(`recording "${scenario.id}": GET /promotions returned HTTP ${listRes.status}`);
  }
  const { candidates } = (await listRes.json()) as { candidates: { artifactId: string; request?: string }[] };
  const candidate = candidates.find((c) => c.request === requestText);
  if (candidate == null) {
    throw new Error(
      `recording "${scenario.id}": no promotion candidate has request ${JSON.stringify(requestText)} ` +
        `(check PROMOTION_MIN_USES in apps/sample-api/src/app/promotions.ts against scenario.repeats)`,
    );
  }
  const approveRes = await app.fetch(
    new Request(`${BASE_URL}/api/kohaku/promotions/${candidate.artifactId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: {
          componentType: "playground.calendarHeatmap",
          version: "1.0.0",
          intentName: "sales.custom",
          description: scenario.label,
        },
      }),
    }),
  );
  if (!approveRes.ok) {
    throw new Error(
      `recording "${scenario.id}": POST /promotions/${candidate.artifactId}/approve returned HTTP ${approveRes.status}: ${await approveRes.text()}`,
    );
  }
}

/**
 * Records one scenario into its own temporary FixtureLlm directory (isolated so this scenario's fixture
 * file contains exactly the calls it made, nothing another scenario's recording session also happened to
 * produce), then folds every `<key>.json` FixtureLlm wrote there into `fixtures/<scenario.id>.json` — a
 * flat `Record<key, ReplayFixtureValue>`, exactly the shape `@kohaku-ui/evals/replay`'s `ReplayLlm` (the
 * array-of-`{key,...}` form is also acceptable, but the Record form needs no transformation from what
 * FixtureLlm already writes).
 */
async function recordScenario(scenario: Scenario, liveLlm: LlmPort): Promise<void> {
  const recordDir = mkdtempSync(join(tmpdir(), `kohaku-playground-record-${scenario.id}-`));
  try {
    const llm = new FixtureLlm(recordDir, { record: true, live: liveLlm });
    const { app } = await createApp({
      llm,
      storage: createMemoryStoragePort(),
      authz: createPlaygroundAuthzPort(RECORD_AUTHZ_SECRET),
      repo: new SalesRepo(PLAYGROUND_SEED),
      now: PLAYGROUND_NOW,
      // Real jsdom/node:vm are available here (a Node script, not the browser bundle) — validates the
      // recorded HTML the same way the real REST server would, catching a runtime error in generated L2
      // markup before it gets baked into a fixture.
      l2Smoke: createL2Smoke(),
    });

    for (let i = 0; i < scenario.repeats; i++) {
      const res = await app.fetch(composeRequest(scenario.input));
      if (!res.ok) {
        throw new Error(
          `recording "${scenario.id}": compose #${i + 1}/${scenario.repeats} returned HTTP ${res.status}: ${await res.text()}`,
        );
      }
    }

    if (scenario.kind === "promotion") {
      if (scenario.input.kind !== "nl") {
        throw new Error(`recording "${scenario.id}": a promotion scenario's input must be an NL request`);
      }
      await approveMatchingCandidate(app, scenario.input.text, scenario);
    }
    // fixation needs no further call here: reaching fixation-eligible (scenario.repeats composes) is the
    // recorded state this scenario wants — approving the proposal needs no LLM call at all (a fixated
    // compose is served from the fixation record, not regenerated), so it is left for a visitor to do
    // themselves in the playground UI, demonstrating the "no further generation" behavior live.

    const merged: Record<string, unknown> = {};
    for (const file of readdirSync(recordDir)) {
      if (!file.endsWith(".json")) continue;
      merged[file.slice(0, -".json".length)] = JSON.parse(readFileSync(join(recordDir, file), "utf8"));
    }
    const entryCount = Object.keys(merged).length;
    if (entryCount === 0) {
      throw new Error(`recording "${scenario.id}": produced no fixture entries at all`);
    }
    writeFileSync(join(FIXTURES_DIR, `${scenario.id}.json`), `${JSON.stringify(merged, null, 2)}\n`);
    console.log(
      `[record-fixtures] wrote fixtures/${scenario.id}.json (${entryCount} ${entryCount === 1 ? "entry" : "entries"})`,
    );
  } finally {
    rmSync(recordDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const liveLlm = createLlmFromEnv();
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const targets = SCENARIOS.filter((s) => s.requiresFixtures);
  console.log(
    `[record-fixtures] recording ${targets.length} scenario(s) with ${liveLlm.provider}/${liveLlm.modelId}...`,
  );
  for (const scenario of targets) {
    await recordScenario(scenario, liveLlm);
  }
}

await main();
