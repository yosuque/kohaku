import type { SampleApp } from "@kohaku-ui-sample/api/browser";
import { SCENARIOS } from "../scenarios.js";
import { RECORDED_SCENARIO_IDS } from "./fixtures.js";

/**
 * Pre-warms the promotion/fixation demo state at startup: composes each `promotion`/`fixation` scenario's
 * request `Scenario.repeats` times, so a promotion candidate and a fixation proposal are already sitting in
 * Admin when the page loads, instead of requiring the visitor to manually repeat a request first. Approving
 * either one (which is what actually invokes the judge's LLM call, for promotion) stays a manual action the
 * visitor takes in Admin — this only reaches the "candidate"/"eligible" state, never approves anything
 * itself.
 *
 * A scenario whose fixture has not been recorded yet is skipped, logged via `console.info` rather than
 * thrown: real-LLM recording has not been done (see docs/user-guide.md §10), so every `promotion`/`fixation` scenario
 * is skipped today, and this function is a deliberate no-op until `record-fixtures.ts` is actually run.
 */
export async function bootstrapDemoState(host: SampleApp): Promise<void> {
  const governed = SCENARIOS.filter((s) => s.kind === "promotion" || s.kind === "fixation");
  for (const scenario of governed) {
    if (!RECORDED_SCENARIO_IDS.has(scenario.id)) {
      console.info(
        `[playground] bootstrap-demo: skipping "${scenario.id}" (${scenario.kind}) — no recorded fixture yet.`,
      );
      continue;
    }
    for (let i = 0; i < scenario.repeats; i++) {
      const res = await host.app.fetch(
        new Request("http://playground.local/api/kohaku/compose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: scenario.input }),
        }),
      );
      if (!res.ok) {
        console.info(
          `[playground] bootstrap-demo: "${scenario.id}" compose #${i + 1} returned HTTP ${res.status}; stopping early.`,
        );
        break;
      }
    }
  }
}
