import { ReplayLlm } from "@kohaku-ui/evals/replay";
import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory/memory";
import { createApp, SalesRepo } from "@kohaku-ui-sample/api/browser";
import { describe, expect, it } from "vitest";
import { createPlaygroundAuthzPort } from "../../src/host/authz.js";
import { PLAYGROUND_NOW } from "../../src/host/create-host.js";
import { loadFixtures, RECORDED_SCENARIO_IDS } from "../../src/host/fixtures.js";
import { PLAYGROUND_SEED } from "../../src/host/seed.js";
import { SCENARIOS, type Scenario } from "../../src/scenarios.js";

/**
 * Replay-only, against whatever `fixtures/*.json` are actually recorded (today: none — see
 * reports/u5-3.md). Never calls a real LLM. Two disjoint groups, by design (not `it.skip`, so an
 * unrecorded scenario is never silently green nor silently invisible):
 * - a `requiresFixtures` scenario WITH a recorded fixture gets its own checks (tier, cache, and the
 *   promotion/fixation-specific outcome).
 * - every `requiresFixtures` scenario WITHOUT one is enumerated in one test, whose name carries the count,
 *   so a missing recording is a visible, named fact about the suite rather than an absence you have to
 *   notice.
 */

async function newHost() {
  return createApp({
    llm: new ReplayLlm(loadFixtures()),
    storage: createMemoryStoragePort(),
    authz: createPlaygroundAuthzPort("drift-test-secret"),
    repo: new SalesRepo(PLAYGROUND_SEED),
    now: PLAYGROUND_NOW,
  });
}

async function compose(app: { fetch(r: Request): Promise<Response> | Response }, input: Scenario["input"]) {
  const res = await app.fetch(
    new Request("http://drift-test.local/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }),
  );
  const json = (await res.json()) as { spec: UISpec; capability: string };
  return { res, json };
}

const l0Scenarios = SCENARIOS.filter((s) => s.kind === "L0");
const fixtureScenarios = SCENARIOS.filter((s) => s.requiresFixtures);
const recordedScenarios = fixtureScenarios.filter((s) => RECORDED_SCENARIO_IDS.has(s.id));
const unrecordedScenarios = fixtureScenarios.filter((s) => !RECORDED_SCENARIO_IDS.has(s.id));

describe.each(l0Scenarios)("L0 scenario: $id", (scenario) => {
  it("composes as L0, a schema-valid Spec (data is $ref-only — SPEC-DATA-001), and hits cache on the 2nd call", async () => {
    const { app } = await newHost();

    const first = await compose(app, scenario.input);
    expect(first.res.status).toBe(200);
    expect(first.json.spec.provenance.tier).toBe("L0");
    expect(first.json.spec.provenance.cache).toBe("miss");
    // parseSpec enforces the full wire schema, including DataRefSchema's .strict() (rows/columns embedded
    // directly on a component would fail this, not just an ad hoc property check).
    expect(() => parseSpec(first.json.spec)).not.toThrow();

    const second = await compose(app, scenario.input);
    expect(second.res.status).toBe(200);
    expect(second.json.spec.provenance.cache).toBe("hit");
  });
});

describe.each(recordedScenarios)("recorded scenario: $id", (scenario) => {
  it("composes without falling back to a Node crash and reaches its expected outcome", async () => {
    const { app } = await newHost();

    let last: Awaited<ReturnType<typeof compose>> | undefined;
    for (let i = 0; i < scenario.repeats; i++) {
      last = await compose(app, scenario.input);
      expect(last.res.status).toBe(200);
    }
    expect(last).toBeDefined();
    // No generation fallback: a fixture that no longer matches the current prompt-building logic (composer,
    // catalog.ts, semantic-port.ts, ...) throws inside ReplayLlm and composer degrades silently — this is
    // exactly what a "drift" test exists to catch (see this file's own doc comment).
    expect(last!.json.spec.provenance.fallback).toBeUndefined();
    expect(() => parseSpec(last!.json.spec)).not.toThrow();

    if (scenario.kind === "L1" || scenario.kind === "fixation") {
      expect(last!.json.spec.provenance.tier).toBe("L1");
    } else if (scenario.kind === "L2" || scenario.kind === "promotion") {
      expect(last!.json.spec.provenance.tier).toBe("L2");
    }

    if (scenario.kind === "promotion") {
      if (scenario.input.kind !== "nl") throw new Error("a promotion scenario's input must be NL");
      const listRes = await app.fetch(new Request("http://drift-test.local/api/kohaku/promotions"));
      const { candidates } = (await listRes.json()) as {
        candidates: { artifactId: string; request?: string }[];
      };
      const candidate = candidates.find((c) => c.request === (scenario.input as { text: string }).text);
      expect(candidate, `no promotion candidate for scenario "${scenario.id}"`).toBeDefined();
      const approveRes = await app.fetch(
        new Request(`http://drift-test.local/api/kohaku/promotions/${candidate!.artifactId}/approve`, {
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
      // Approving is what invokes the judge's LLM call (apps/sample-api/src/app/promotions.ts) — a 200 here
      // proves that fixture entry also replays cleanly, on top of the L2 generation fixture checked above.
      expect(approveRes.status).toBe(200);
    }

    if (scenario.kind === "fixation") {
      // Reaching fixation-eligible (scenario.repeats composes, already done above) needs a human approval
      // to actually fix it — see host-rest's POST /fixations/approve. Once approved, a further compose of
      // the same request is served from the fixation record: cache becomes "fixated", not "hit"/"miss".
      const proposalsRes = await app.fetch(
        new Request("http://drift-test.local/api/kohaku/fixations/proposals"),
      );
      const { proposals } = (await proposalsRes.json()) as { proposals: { intentHash: string }[] };
      expect(proposals.length, `no fixation proposal for scenario "${scenario.id}"`).toBeGreaterThan(0);
      const approveRes = await app.fetch(
        new Request("http://drift-test.local/api/kohaku/fixations/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intentHash: proposals[0]!.intentHash }),
        }),
      );
      expect(approveRes.status).toBe(200);
      const afterFix = await compose(app, scenario.input);
      expect(afterFix.json.spec.provenance.cache).toBe("fixated");
    }
  });
});

it(`${unrecordedScenarios.length} scenario(s) awaiting recording: ${unrecordedScenarios.map((s) => s.id).join(", ")}`, () => {
  // Deliberately not it.skip: a scenario with no recorded fixture is a fact about the suite worth seeing in
  // the test list every run, not a silently-absent or silently-passing one. See reports/u5-3.md for why
  // real-LLM recording is postponed — this count should read 0 once it no longer is.
  expect(unrecordedScenarios.map((s) => s.id)).toEqual(
    fixtureScenarios.map((s) => s.id).filter((id) => !RECORDED_SCENARIO_IDS.has(id)),
  );
});
