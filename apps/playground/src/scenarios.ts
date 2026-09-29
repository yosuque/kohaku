/**
 * The single list of playground scenarios, shared by the UI (`PlaygroundBar`'s example buttons), the
 * fixture recorder (`scripts/record-fixtures.ts`, written but never run — see docs/user-guide.md §10), the demo
 * bootstrap (`host/bootstrap-demo.ts`), and the drift test (`test/drift/fixtures-drift.test.ts`). Adding a
 * scenario here is the only place any of those four need to change.
 */

export type ScenarioKind = "L0" | "L1" | "NL" | "L2" | "promotion" | "fixation";

/** The `input` field of a POST /api/kohaku/compose request body (host-rest's ComposeBodySchema). */
export type ScenarioInput =
  | { kind: "gui"; action: "view.select"; params: Record<string, unknown> }
  | { kind: "nl"; text: string };

export interface Scenario {
  /** Stable id: the fixture file name (`fixtures/<id>.json`) and the drift test's row key. Never reuse an
   * id for a different request shape — a stale fixture would silently replay the wrong response. */
  id: string;
  /** Display label (English only — PlaygroundBar is not localized; see its own doc comment). */
  label: string;
  kind: ScenarioKind;
  input: ScenarioInput;
  /**
   * How many times `input` must be composed for the scenario's outcome to be meaningful:
   * - L0 / L1 / NL / L2: 1 (a single compose call; a repeat would be a cache hit, not a new observation).
   * - promotion: `PROMOTION_MIN_USES` (apps/sample-api/src/app/promotions.ts) — that many composes of the
   *   same request nominate it as a promotion candidate. Approving the candidate (a separate admin action,
   *   not part of this scenario's `repeats`) is what actually invokes the judge's LLM call.
   * - fixation: `FIXATION_MIN_USES` (apps/sample-api/src/app-core.ts) — that many composes of the same
   *   request make it fixation-eligible. Approving the proposal (again a separate admin action) needs no
   *   further LLM call — a fixated compose is served from the fixation record, not regenerated.
   */
  repeats: number;
  /**
   * Whether composing this scenario calls the LLM at all. false only for the 4 L0 fixed-spec Intents
   * (apps/sample-api/src/intents/fixed-specs.ts), which never reach the LLM regardless of fixtures.
   */
  requiresFixtures: boolean;
}

export const SCENARIOS: Scenario[] = [
  // --- L0: fixed specs, never touch the LLM. Work today, with zero recorded fixtures.
  {
    id: "l0-quarterly-summary",
    label: "Quarterly summary (by region)",
    kind: "L0",
    input: {
      kind: "gui",
      action: "view.select",
      params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 3, groupBy: "region" },
    },
    repeats: 1,
    requiresFixtures: false,
  },
  {
    id: "l0-kpi-overview",
    label: "KPI overview",
    kind: "L0",
    input: { kind: "gui", action: "view.select", params: { intent: "sales.kpi_overview", fiscalYear: 2026 } },
    repeats: 1,
    requiresFixtures: false,
  },
  {
    id: "l0-records",
    label: "Sales records",
    kind: "L0",
    input: { kind: "gui", action: "view.select", params: { intent: "sales.records", limit: 50 } },
    repeats: 1,
    requiresFixtures: false,
  },
  {
    id: "l0-target-attainment",
    label: "Target attainment",
    kind: "L0",
    input: {
      kind: "gui",
      action: "view.select",
      params: { intent: "sales.target_attainment", fiscalYear: 2026, quarter: 2 },
    },
    repeats: 1,
    requiresFixtures: false,
  },

  // --- L1: declarative LLM composition (composer's deterministic post-processing corrects the shape).
  {
    id: "l1-trend",
    label: "Monthly revenue trend",
    kind: "L1",
    input: {
      kind: "gui",
      action: "view.select",
      params: { intent: "sales.trend", metric: "revenue", granularity: "month" },
    },
    repeats: 1,
    requiresFixtures: true,
  },
  {
    id: "l1-by-product",
    label: "Top products by revenue",
    kind: "L1",
    input: {
      kind: "gui",
      action: "view.select",
      params: { intent: "sales.by_product", fiscalYear: 2026, metric: "revenue", topN: 5 },
    },
    repeats: 1,
    requiresFixtures: true,
  },

  // --- NL: natural-language normalization (semantic-llm resolves the question to an Intent + params).
  {
    id: "nl-quarterly-summary",
    label: '"How did this quarter go by region?"',
    kind: "NL",
    input: { kind: "nl", text: "How did this quarter go by region?" },
    repeats: 1,
    requiresFixtures: true,
  },

  // --- L2: free-form generation (no Intent covers this request shape).
  {
    id: "l2-calendar-heatmap",
    label: "Sales as a calendar heatmap",
    kind: "L2",
    input: { kind: "nl", text: "Show sales as a calendar heatmap" },
    repeats: 1,
    requiresFixtures: true,
  },

  // --- promotion: the same L2 request as l2-calendar-heatmap, composed enough times to become a
  // candidate. Shares that scenario's fixture key for the generation call; the judge's own LLM call
  // (invoked only when an admin approves the candidate) needs a second, distinct fixture entry.
  {
    id: "promotion-calendar-heatmap",
    label: "Promote the calendar heatmap (judge preview)",
    kind: "promotion",
    input: { kind: "nl", text: "Show sales as a calendar heatmap" },
    repeats: 2, // PROMOTION_MIN_USES
    requiresFixtures: true,
  },

  // --- fixation: the same L1 request as l1-trend, composed enough times to become fixation-eligible.
  {
    id: "fixation-trend",
    label: "Fix the monthly revenue trend",
    kind: "fixation",
    input: {
      kind: "gui",
      action: "view.select",
      params: { intent: "sales.trend", metric: "revenue", granularity: "month" },
    },
    repeats: 3, // FIXATION_MIN_USES
    requiresFixtures: true,
  },
];
