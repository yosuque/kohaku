// golden spec corpus (both renderers consume the same input).
// A set of Specs covering the core parts + a Spec with A1 two-way binding. Because charts have SVG implementation
// differences, they are handled not by structural parity but by chart.test.ts's semantic equivalence (matching a11y tables);
// CHART_CORPUS lives here (rather than in chart.test.ts) so a11y.test.ts can iterate the same golden Specs.

import type { BindingClient } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";

const INTENT = { canonical: "parity.corpus", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "parity", cache: "hit" } as const;

/** Reference-passed data (2 rows shared by all Specs). Also has the metric's delta column. */
export const CORPUS_ROWS: TabularData["rows"] = [
  { region: "japan", revenue: 498200000, delta: 12000000 },
  { region: "north_america", revenue: 612800000, delta: -3000000 },
];

function corpusData(rows: TabularData["rows"] = CORPUS_ROWS): TabularData {
  return {
    columns: [
      { key: "region", label: "Region", type: "string" },
      { key: "revenue", label: "Revenue", type: "number" },
      { key: "delta", label: "Change", type: "number" },
    ],
    rows,
    dataVersion: "v1",
  };
}

/** Shared binding that returns rows depending on the ref. A1's region branch is also initially resolved with the same data. */
export function corpusBinding(): BindingClient {
  return {
    async resolve(ref) {
      const s = typeof ref === "string" ? ref : ref.$ref;
      // A1: for region=us, return only 1 row (initially japan, identical for both).
      if (s.includes("region=us")) return corpusData([{ region: "us", revenue: 1000, delta: 0 }]);
      return corpusData();
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

const REF = "query://sales/summary";
const BIND_REF = "query://sales/records?region=japan";

function spec(partial: {
  components: unknown[];
  events?: unknown[];
  state?: Record<string, unknown>;
  refVersions?: Record<string, string>;
}): UISpec {
  return parseSpec({
    kohaku: partial.state != null ? "0.2" : "0.1",
    intent: INTENT,
    dataVersion: "v1",
    ...(partial.refVersions != null ? { refVersions: partial.refVersions } : {}),
    ...(partial.state != null ? { state: partial.state } : {}),
    components: partial.components,
    events: partial.events ?? [],
    provenance: PROVENANCE,
  });
}

/** Structural-parity corpus (no charts). name → Spec. */
export const STRUCTURAL_CORPUS: Record<string, UISpec> = {
  "layout.stack + text.heading": spec({
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: "lg" },
        children: ["h1", "h2"],
      },
      { id: "h1", type: "text.heading", props: { level: 2, text: "Heading A" } },
      { id: "h2", type: "text.heading", props: { level: 3, text: "Heading B" } },
    ],
  }),

  "layout.grid": spec({
    components: [
      { id: "root", type: "layout.grid", props: { columns: 3, gap: "sm" }, children: ["a", "b", "c"] },
      { id: "a", type: "text.heading", props: { level: 4, text: "A" } },
      { id: "b", type: "text.heading", props: { level: 4, text: "B" } },
      { id: "c", type: "text.heading", props: { level: 4, text: "C" } },
    ],
  }),

  presentMarkdown: spec({
    components: [
      {
        id: "root",
        type: "presentMarkdown",
        props: {
          markdown:
            "# Heading\n\nA paragraph with `code` and **emphasis**.\n\n- Bullet 1\n- Bullet 2\n\n```\nconst x = 1;\n```\n\n> Quote line",
        },
      },
    ],
  }),

  presentMetric: spec({
    components: [
      {
        id: "root",
        type: "presentMetric",
        props: {
          label: "Revenue",
          valueColumn: "revenue",
          deltaColumn: "delta",
          format: "currency",
          currency: "JPY",
        },
        data: { $ref: REF },
      },
    ],
    refVersions: { [REF]: "v1" },
  }),

  "presentMetric(percent + unit + negative delta)": spec({
    components: [
      {
        id: "root",
        type: "presentMetric",
        props: {
          label: "Attainment rate",
          valueColumn: "revenue",
          deltaColumn: "delta",
          format: "number",
          positiveIsGood: false,
        },
        data: { $ref: REF },
      },
    ],
    refVersions: { [REF]: "v1" },
  }),

  presentSpreadsheet: spec({
    components: [{ id: "root", type: "presentSpreadsheet", props: {}, data: { $ref: REF } }],
    refVersions: { [REF]: "v1" },
  }),

  "presentSpreadsheet(pageSize truncation footer)": spec({
    components: [{ id: "root", type: "presentSpreadsheet", props: { pageSize: 1 }, data: { $ref: REF } }],
    refVersions: { [REF]: "v1" },
  }),

  "presentList(row template)": spec({
    components: [
      { id: "root", type: "presentList", props: {}, data: { $ref: REF }, children: ["row"] },
      { id: "row", type: "text.heading", props: { text: "$row.region", level: 4 } },
    ],
    refVersions: { [REF]: "v1" },
    events: [{ on: "root.itemClick", emit: "intent.replace", payload: { region: "$row.region" } }],
  }),

  "action.button": spec({
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["b1", "b2"] },
      { id: "b1", type: "action.button", props: { label: "Default" } },
      { id: "b2", type: "action.button", props: { label: "Primary", variant: "primary" } },
    ],
    events: [{ on: "b2.press", emit: "intent.replace", payload: { kind: "go" } }],
  }),

  "control.select": spec({
    state: { region: "japan" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["sel"] },
      {
        id: "sel",
        type: "control.select",
        props: { label: "Region", options: ["japan", "us"], value: "japan" },
      },
    ],
    events: [{ on: "sel.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
  }),

  "ui.loading": spec({
    components: [{ id: "root", type: "ui.loading", props: { label: "Loading" } }],
  }),

  "layout.tabs(state-driven)": spec({
    state: { tab: "a" },
    components: [
      { id: "root", type: "layout.tabs", props: { stateKey: "tab" }, children: ["ta", "tb"] },
      { id: "ta", type: "layout.tab", props: { value: "a", label: "Side A" }, children: ["ha"] },
      { id: "tb", type: "layout.tab", props: { value: "b", label: "Side B" }, children: ["hb"] },
      { id: "ha", type: "text.heading", props: { text: "Panel A" } },
      { id: "hb", type: "text.heading", props: { text: "Panel B" } },
    ],
  }),

  "visibleWhen(initially true)": spec({
    state: { mode: "show" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["panel"] },
      {
        id: "panel",
        type: "text.heading",
        props: { text: "Visible" },
        visibleWhen: { ref: "$state.mode", eq: "show" },
      },
    ],
  }),

  "presentForm(fields + submit)": spec({
    components: [
      {
        id: "root",
        type: "presentForm",
        props: {
          action: "annotate",
          submitLabel: "Save",
          fields: [
            { name: "note", type: "text", label: "Note" },
            { name: "score", type: "number", label: "Score", min: 0, max: 10 },
            { name: "region", type: "select", label: "Region", options: ["japan", "us"] },
          ],
        },
      },
    ],
    events: [{ on: "root.submit", emit: "action.invoke", payload: { note: "$value.note" } }],
  }),

  // Covers every control-type branch of the form's per-type switch (date/email/url/textarea/boolean/radio/multiselect),
  // including required marks, helpText (aria-describedby), placeholder, and defaultValue — the characterization net
  // for extracting the control decision table into renderer-core.
  "presentForm(all control types)": spec({
    components: [
      {
        id: "root",
        type: "presentForm",
        props: {
          action: "annotate",
          submitLabel: "Save",
          fields: [
            { name: "when", type: "date", label: "Date", required: true, min: 20260101 },
            { name: "mail", type: "email", label: "Email", placeholder: "a@example.com" },
            { name: "site", type: "url", label: "Site", helpText: "Include https://" },
            { name: "memo", type: "textarea", label: "Memo", maxLength: 200 },
            { name: "active", type: "boolean", label: "Active", defaultValue: true },
            {
              name: "channel",
              type: "radio",
              label: "Channel",
              options: ["direct", "partner"],
              defaultValue: "direct",
            },
            {
              name: "regions",
              type: "multiselect",
              label: "Regions",
              options: [
                { value: "japan", label: "Japan" },
                { value: "us", label: "US" },
              ],
              defaultValue: ["japan"],
              helpText: "Multiple choices allowed",
            },
          ],
        },
      },
    ],
    events: [{ on: "root.submit", emit: "action.invoke", payload: { memo: "$value.memo" } }],
  }),

  "A1 two-way binding(initial variant)": spec({
    state: { region: "japan" },
    refVersions: { [BIND_REF]: "v1" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["sel", "tbl"] },
      {
        id: "sel",
        type: "control.select",
        props: { label: "Region", options: ["japan", "us"], value: "japan" },
      },
      {
        id: "tbl",
        type: "presentSpreadsheet",
        props: {},
        data: { $ref: BIND_REF, bind: { region: { $state: "region", values: ["japan", "us"] } } },
      },
    ],
    events: [{ on: "sel.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
  }),
};

const CHART_REF = "query://sales/summary";

function chartSpec(props: Record<string, unknown>): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: { canonical: "parity.chart", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    refVersions: { [CHART_REF]: "v1" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["chart1"] },
      { id: "chart1", type: "presentChart", props, data: { $ref: CHART_REF } },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

/** Chart corpus (SVG-implementation-divergent parts; semantic equivalence, not structural, is claimed for these — see chart.test.ts). */
export const CHART_CORPUS: Record<string, UISpec> = {
  bar: chartSpec({ kind: "bar", x: "region", y: "revenue", title: "Sales by region" }),
  line: chartSpec({ kind: "line", x: "region", y: ["revenue", "delta"] }),
  area: chartSpec({ kind: "area", x: "region", y: "revenue" }),
  "pie(table fallback)": chartSpec({ kind: "pie", x: "region", y: "revenue" }),
  "scatter(table fallback)": chartSpec({ kind: "scatter", x: "region", y: "revenue" }),
};

export { BIND_REF, REF };
