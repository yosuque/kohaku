import type { CanonicalIntent, QueryHandle, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { summary } from "../src/domain/queries.js";
import { SalesRepo } from "../src/domain/repo.js";
import { createFixedSpecs, type OutputLang } from "../src/intents/fixed-specs.js";

// Byte-stability guard for the fixed-specs.ts refactor (Replace Conditional with Lookup Table):
// pins every L0 fixed-spec template's full output (EN + JA, every branch) so the refactor from
// scattered `lang === "ja" ? … : …` conditionals to a language dictionary cannot silently change
// any user-visible text or the Spec's shape/key order. If any snapshot below changes, the refactor
// introduced a behavior change and must be fixed, not re-snapshotted.
//
// Note: en/ja variants are written as separate `it()` blocks (not a shared loop) on purpose — each
// `toMatchInlineSnapshot()` call must sit at its own source location, since the inline-snapshot
// mechanism keys the expected value by call site, not by test name.
//
// sales.records is the one deliberate exception to "any snapshot change means a bug": its "g"
// (presentSpreadsheet) component's props gained `serverSide: true` (sort/paging now go through the
// reserved _sort/_dir/_cursor/_limit params instead of a one-shot full fetch), so the four sales.records
// snapshots below were re-recorded for that reason alone — every other field is unchanged.

/** A deterministic dummy hash — fixed-specs.ts never reads it, only carries it through to spec.intent. */
const HASH = `sha256:${"0".repeat(64)}`;

function intent(canonical: string, params: Record<string, unknown>): CanonicalIntent {
  return { canonical, params: params as CanonicalIntent["params"], hash: HASH };
}

function refs(...uris: string[]): QueryHandle[] {
  return uris.map((uri) => ({ uri }));
}

/** Looks up and invokes the fixed-spec builder for one (lang, intent, refs) combination. */
async function build(lang: OutputLang, i: CanonicalIntent, r: QueryHandle[]): Promise<UISpec> {
  const source = createFixedSpecs(lang);
  const builder = await source.lookup(i);
  if (typeof builder !== "function") {
    throw new Error(`no fixed-spec builder for ${i.canonical}`);
  }
  return builder(i, r);
}

describe("fixed-specs snapshot: sales.quarterly_summary", () => {
  it("en: groupBy=region, no region filter (chart+table, drilldown event)", async () => {
    const spec = await build(
      "en",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "region" }),
      refs("query://sales/summary?fy=2026&groupBy=region&q=3"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Q3 Sales (by Region)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "intent.patch",
            "on": "g.rowClick",
            "payload": {
              "drilldown": "$row.region",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "region",
            "quarter": 3,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
  it("ja: groupBy=region, no region filter (chart+table, drilldown event)", async () => {
    const spec = await build(
      "ja",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "region" }),
      refs("query://sales/summary?fy=2026&groupBy=region&q=3"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度Q3 売上(地域別)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "intent.patch",
            "on": "g.rowClick",
            "payload": {
              "drilldown": "$row.region",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "region",
            "quarter": 3,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });

  it("en: groupBy=product, no region filter (no drilldown event)", async () => {
    const spec = await build(
      "en",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "product" }),
      refs("query://sales/summary?fy=2026&groupBy=product&q=3"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Q3 Sales (by Product)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "product",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "product",
            "quarter": 3,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
  it("ja: groupBy=product, no region filter (no drilldown event)", async () => {
    const spec = await build(
      "ja",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "product" }),
      refs("query://sales/summary?fy=2026&groupBy=product&q=3"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度Q3 売上(製品別)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "product",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "product",
            "quarter": 3,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });

  it("en: groupBy=channel, no region filter", async () => {
    const spec = await build(
      "en",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "channel" }),
      refs("query://sales/summary?fy=2026&groupBy=channel&q=3"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Q3 Sales (by Channel)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=channel&q=3",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "channel",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=channel&q=3",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "channel",
            "quarter": 3,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
  it("ja: groupBy=channel, no region filter", async () => {
    const spec = await build(
      "ja",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "channel" }),
      refs("query://sales/summary?fy=2026&groupBy=channel&q=3"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度Q3 売上(チャネル別)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=channel&q=3",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "channel",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=channel&q=3",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "channel",
            "quarter": 3,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });

  it("en: minimal params (no quarter, no groupBy → defaults to region, no region filter)", async () => {
    const spec = await build(
      "en",
      intent("sales.quarterly_summary", { fiscalYear: 2026 }),
      refs("query://sales/summary?fy=2026&groupBy=region"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Sales (by Region)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "intent.patch",
            "on": "g.rowClick",
            "payload": {
              "drilldown": "$row.region",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
  it("ja: minimal params (no quarter, no groupBy → defaults to region, no region filter)", async () => {
    const spec = await build(
      "ja",
      intent("sales.quarterly_summary", { fiscalYear: 2026 }),
      refs("query://sales/summary?fy=2026&groupBy=region"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度 売上(地域別)",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "intent.patch",
            "on": "g.rowClick",
            "payload": {
              "drilldown": "$row.region",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });

  it("en: region cross-filter, groupBy=region (region drilldown breakdown)", async () => {
    const spec = await build(
      "en",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "region", region: "japan" }),
      refs("query://sales/summary?fy=2026&groupBy=region&q=3&region=japan"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "hint",
              "filter",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Q3 Region cross-filter (breakdown by Region)",
            },
            "type": "text.heading",
          },
          {
            "id": "hint",
            "props": {
              "markdown": "Switching the region re-resolves the chart and table **without a compose round-trip (server round-trip / LLM)** — the effective ref inside the client is swapped via \`data.bind\`.",
            },
            "type": "presentMarkdown",
          },
          {
            "id": "filter",
            "props": {
              "label": "Region",
              "options": [
                {
                  "label": "Japan",
                  "value": "japan",
                },
                {
                  "label": "North America",
                  "value": "north_america",
                },
                {
                  "label": "Europe",
                  "value": "europe",
                },
                {
                  "label": "APAC",
                  "value": "apac",
                },
              ],
              "value": "japan",
            },
            "type": "control.select",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3&region=japan",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3&region=japan",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "filter.change",
            "payload": {
              "key": "region",
              "value": "$value",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "region",
            "quarter": 3,
            "region": "japan",
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "region": "japan",
        },
      }
    `);
  });
  it("ja: region cross-filter, groupBy=region (region drilldown breakdown)", async () => {
    const spec = await build(
      "ja",
      intent("sales.quarterly_summary", { fiscalYear: 2026, quarter: 3, groupBy: "region", region: "japan" }),
      refs("query://sales/summary?fy=2026&groupBy=region&q=3&region=japan"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "hint",
              "filter",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度Q3 地域クロスフィルター(地域別の内訳)",
            },
            "type": "text.heading",
          },
          {
            "id": "hint",
            "props": {
              "markdown": "地域を切り替えると、compose の往復(サーバー往復 / LLM)**なし**にチャートと表が再解決されます — \`data.bind\` によりクライアント内部で実効 ref が差し替わります。",
            },
            "type": "presentMarkdown",
          },
          {
            "id": "filter",
            "props": {
              "label": "地域",
              "options": [
                {
                  "label": "日本",
                  "value": "japan",
                },
                {
                  "label": "北米",
                  "value": "north_america",
                },
                {
                  "label": "欧州",
                  "value": "europe",
                },
                {
                  "label": "APAC",
                  "value": "apac",
                },
              ],
              "value": "japan",
            },
            "type": "control.select",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3&region=japan",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3&region=japan",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "filter.change",
            "payload": {
              "key": "region",
              "value": "$value",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "region",
            "quarter": 3,
            "region": "japan",
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "region": "japan",
        },
      }
    `);
  });

  it("en: region cross-filter, groupBy=product (non-region breakdown)", async () => {
    const spec = await build(
      "en",
      intent("sales.quarterly_summary", {
        fiscalYear: 2026,
        quarter: 3,
        groupBy: "product",
        region: "north_america",
      }),
      refs("query://sales/summary?fy=2026&groupBy=product&q=3&region=north_america"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "hint",
              "filter",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Q3 Region cross-filter (breakdown by Product)",
            },
            "type": "text.heading",
          },
          {
            "id": "hint",
            "props": {
              "markdown": "Switching the region re-resolves the chart and table **without a compose round-trip (server round-trip / LLM)** — the effective ref inside the client is swapped via \`data.bind\`.",
            },
            "type": "presentMarkdown",
          },
          {
            "id": "filter",
            "props": {
              "label": "Region",
              "options": [
                {
                  "label": "Japan",
                  "value": "japan",
                },
                {
                  "label": "North America",
                  "value": "north_america",
                },
                {
                  "label": "Europe",
                  "value": "europe",
                },
                {
                  "label": "APAC",
                  "value": "apac",
                },
              ],
              "value": "north_america",
            },
            "type": "control.select",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3&region=north_america",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "product",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3&region=north_america",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "filter.change",
            "payload": {
              "key": "region",
              "value": "$value",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "product",
            "quarter": 3,
            "region": "north_america",
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "region": "north_america",
        },
      }
    `);
  });
  it("ja: region cross-filter, groupBy=product (non-region breakdown)", async () => {
    const spec = await build(
      "ja",
      intent("sales.quarterly_summary", {
        fiscalYear: 2026,
        quarter: 3,
        groupBy: "product",
        region: "north_america",
      }),
      refs("query://sales/summary?fy=2026&groupBy=product&q=3&region=north_america"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "hint",
              "filter",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度Q3 地域クロスフィルター(製品別の内訳)",
            },
            "type": "text.heading",
          },
          {
            "id": "hint",
            "props": {
              "markdown": "地域を切り替えると、compose の往復(サーバー往復 / LLM)**なし**にチャートと表が再解決されます — \`data.bind\` によりクライアント内部で実効 ref が差し替わります。",
            },
            "type": "presentMarkdown",
          },
          {
            "id": "filter",
            "props": {
              "label": "地域",
              "options": [
                {
                  "label": "日本",
                  "value": "japan",
                },
                {
                  "label": "北米",
                  "value": "north_america",
                },
                {
                  "label": "欧州",
                  "value": "europe",
                },
                {
                  "label": "APAC",
                  "value": "apac",
                },
              ],
              "value": "north_america",
            },
            "type": "control.select",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3&region=north_america",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "product",
              "y": "revenue",
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/summary?fy=2026&groupBy=product&q=3&region=north_america",
              "bind": {
                "region": {
                  "$state": "region",
                  "values": [
                    "japan",
                    "north_america",
                    "europe",
                    "apac",
                  ],
                },
              },
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "filter.change",
            "payload": {
              "key": "region",
              "value": "$value",
            },
          },
        ],
        "intent": {
          "canonical": "sales.quarterly_summary",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "groupBy": "product",
            "quarter": 3,
            "region": "north_america",
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "region": "north_america",
        },
      }
    `);
  });
});

describe("fixed-specs snapshot: sales.kpi_overview", () => {
  it("en: quarter present", async () => {
    const spec = await build(
      "en",
      intent("sales.kpi_overview", { fiscalYear: 2026, quarter: 2 }),
      refs(
        "query://sales/kpi?fy=2026&metric=total_revenue&q=2",
        "query://sales/kpi?fy=2026&metric=yoy&q=2",
        "query://sales/kpi?fy=2026&metric=top_region&q=2",
        "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
      ),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "grid",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Q2 Performance Summary",
            },
            "type": "text.heading",
          },
          {
            "children": [
              "k0",
              "k1",
              "k2",
              "k3",
            ],
            "id": "grid",
            "props": {
              "columns": 4,
              "gap": "md",
            },
            "type": "layout.grid",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=total_revenue&q=2",
            },
            "id": "k0",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=yoy&q=2",
            },
            "id": "k1",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=top_region&q=2",
            },
            "id": "k2",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
            },
            "id": "k3",
            "props": {},
            "type": "sales.kpiCard",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.kpi_overview",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "quarter": 2,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
  it("ja: quarter present", async () => {
    const spec = await build(
      "ja",
      intent("sales.kpi_overview", { fiscalYear: 2026, quarter: 2 }),
      refs(
        "query://sales/kpi?fy=2026&metric=total_revenue&q=2",
        "query://sales/kpi?fy=2026&metric=yoy&q=2",
        "query://sales/kpi?fy=2026&metric=top_region&q=2",
        "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
      ),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "grid",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度Q2 業績サマリー",
            },
            "type": "text.heading",
          },
          {
            "children": [
              "k0",
              "k1",
              "k2",
              "k3",
            ],
            "id": "grid",
            "props": {
              "columns": 4,
              "gap": "md",
            },
            "type": "layout.grid",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=total_revenue&q=2",
            },
            "id": "k0",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=yoy&q=2",
            },
            "id": "k1",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=top_region&q=2",
            },
            "id": "k2",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
            },
            "id": "k3",
            "props": {},
            "type": "sales.kpiCard",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.kpi_overview",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "quarter": 2,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });

  it("en: quarter absent (full year)", async () => {
    const spec = await build(
      "en",
      intent("sales.kpi_overview", { fiscalYear: 2026 }),
      refs(
        "query://sales/kpi?fy=2026&metric=total_revenue",
        "query://sales/kpi?fy=2026&metric=yoy",
        "query://sales/kpi?fy=2026&metric=top_region",
        "query://sales/kpi?fy=2026&metric=target_attainment",
      ),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "grid",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Full year Performance Summary",
            },
            "type": "text.heading",
          },
          {
            "children": [
              "k0",
              "k1",
              "k2",
              "k3",
            ],
            "id": "grid",
            "props": {
              "columns": 4,
              "gap": "md",
            },
            "type": "layout.grid",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=total_revenue",
            },
            "id": "k0",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=yoy",
            },
            "id": "k1",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=top_region",
            },
            "id": "k2",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=target_attainment",
            },
            "id": "k3",
            "props": {},
            "type": "sales.kpiCard",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.kpi_overview",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
  it("ja: quarter absent (full year)", async () => {
    const spec = await build(
      "ja",
      intent("sales.kpi_overview", { fiscalYear: 2026 }),
      refs(
        "query://sales/kpi?fy=2026&metric=total_revenue",
        "query://sales/kpi?fy=2026&metric=yoy",
        "query://sales/kpi?fy=2026&metric=top_region",
        "query://sales/kpi?fy=2026&metric=target_attainment",
      ),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "grid",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度 通年 業績サマリー",
            },
            "type": "text.heading",
          },
          {
            "children": [
              "k0",
              "k1",
              "k2",
              "k3",
            ],
            "id": "grid",
            "props": {
              "columns": 4,
              "gap": "md",
            },
            "type": "layout.grid",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=total_revenue",
            },
            "id": "k0",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=yoy",
            },
            "id": "k1",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=top_region",
            },
            "id": "k2",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=target_attainment",
            },
            "id": "k3",
            "props": {},
            "type": "sales.kpiCard",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.kpi_overview",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
});

describe("fixed-specs snapshot: sales.records", () => {
  it("en: full scope (fiscalYear + quarter + region), custom limit", async () => {
    const spec = await build(
      "en",
      intent("sales.records", {
        fiscalYear: 2026,
        quarter: 3,
        region: "japan",
        channel: "direct",
        productId: "p1",
        limit: 50,
      }),
      refs("query://sales/records?fy=2026&q=3&region=japan&channel=direct&productId=p1&limit=50"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "openNote",
              "noteDialog",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "Sales Records (FY2026 Q3 Japan)",
            },
            "type": "text.heading",
          },
          {
            "id": "openNote",
            "props": {
              "label": "Add a note",
              "variant": "secondary",
            },
            "type": "action.button",
          },
          {
            "children": [
              "noteForm",
            ],
            "id": "noteDialog",
            "props": {
              "description": "Writes go part → API directly (with a capability token) and never pass through the LLM's context.",
              "title": "Add a note to these records",
            },
            "type": "overlay.dialog",
            "visibleWhen": {
              "eq": true,
              "ref": "$state.noteOpen",
            },
          },
          {
            "id": "noteForm",
            "props": {
              "action": "annotate",
              "fields": [
                {
                  "label": "Note for these records",
                  "name": "note",
                  "placeholder": "e.g. Check North America's growth",
                  "required": true,
                  "type": "text",
                },
              ],
              "submitLabel": "Save",
              "successMessage": "Note saved (the table was refetched at the latest data version).",
            },
            "type": "presentForm",
          },
          {
            "data": {
              "$ref": "query://sales/records?fy=2026&q=3&region=japan&channel=direct&productId=p1&limit=50",
            },
            "id": "g",
            "props": {
              "editable": false,
              "pageSize": 50,
              "serverSide": true,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "openNote.press",
            "payload": {
              "key": "noteOpen",
              "value": true,
            },
          },
          {
            "emit": "state.set",
            "on": "noteDialog.close",
            "payload": {
              "key": "noteOpen",
              "value": false,
            },
          },
          {
            "emit": "action.invoke",
            "on": "noteForm.submit",
            "payload": {
              "note": "$value.note",
              "refs": [
                "query://sales/records?fy=2026&q=3&region=japan&channel=direct&productId=p1&limit=50",
              ],
            },
          },
        ],
        "intent": {
          "canonical": "sales.records",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "channel": "direct",
            "fiscalYear": 2026,
            "limit": 50,
            "productId": "p1",
            "quarter": 3,
            "region": "japan",
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "noteOpen": false,
        },
      }
    `);
  });
  it("ja: full scope (fiscalYear + quarter + region), custom limit", async () => {
    const spec = await build(
      "ja",
      intent("sales.records", {
        fiscalYear: 2026,
        quarter: 3,
        region: "japan",
        channel: "direct",
        productId: "p1",
        limit: 50,
      }),
      refs("query://sales/records?fy=2026&q=3&region=japan&channel=direct&productId=p1&limit=50"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "openNote",
              "noteDialog",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "売上明細(2026年度 Q3 日本)",
            },
            "type": "text.heading",
          },
          {
            "id": "openNote",
            "props": {
              "label": "メモを追加",
              "variant": "secondary",
            },
            "type": "action.button",
          },
          {
            "children": [
              "noteForm",
            ],
            "id": "noteDialog",
            "props": {
              "description": "書き込みは part → API へ直接(capability トークン付き)行われ、LLM のコンテキストを経由しません。",
              "title": "この明細にメモを追加",
            },
            "type": "overlay.dialog",
            "visibleWhen": {
              "eq": true,
              "ref": "$state.noteOpen",
            },
          },
          {
            "id": "noteForm",
            "props": {
              "action": "annotate",
              "fields": [
                {
                  "label": "この明細へのメモ",
                  "name": "note",
                  "placeholder": "例: 北米の成長を確認",
                  "required": true,
                  "type": "text",
                },
              ],
              "submitLabel": "保存",
              "successMessage": "メモを保存しました(表は最新のデータバージョンで再取得されました)。",
            },
            "type": "presentForm",
          },
          {
            "data": {
              "$ref": "query://sales/records?fy=2026&q=3&region=japan&channel=direct&productId=p1&limit=50",
            },
            "id": "g",
            "props": {
              "editable": false,
              "pageSize": 50,
              "serverSide": true,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "openNote.press",
            "payload": {
              "key": "noteOpen",
              "value": true,
            },
          },
          {
            "emit": "state.set",
            "on": "noteDialog.close",
            "payload": {
              "key": "noteOpen",
              "value": false,
            },
          },
          {
            "emit": "action.invoke",
            "on": "noteForm.submit",
            "payload": {
              "note": "$value.note",
              "refs": [
                "query://sales/records?fy=2026&q=3&region=japan&channel=direct&productId=p1&limit=50",
              ],
            },
          },
        ],
        "intent": {
          "canonical": "sales.records",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "channel": "direct",
            "fiscalYear": 2026,
            "limit": 50,
            "productId": "p1",
            "quarter": 3,
            "region": "japan",
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "noteOpen": false,
        },
      }
    `);
  });

  it("en: empty scope (no fiscalYear, no quarter, no region), default limit", async () => {
    const spec = await build("en", intent("sales.records", {}), refs("query://sales/records"));
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "openNote",
              "noteDialog",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "Sales Records (All periods)",
            },
            "type": "text.heading",
          },
          {
            "id": "openNote",
            "props": {
              "label": "Add a note",
              "variant": "secondary",
            },
            "type": "action.button",
          },
          {
            "children": [
              "noteForm",
            ],
            "id": "noteDialog",
            "props": {
              "description": "Writes go part → API directly (with a capability token) and never pass through the LLM's context.",
              "title": "Add a note to these records",
            },
            "type": "overlay.dialog",
            "visibleWhen": {
              "eq": true,
              "ref": "$state.noteOpen",
            },
          },
          {
            "id": "noteForm",
            "props": {
              "action": "annotate",
              "fields": [
                {
                  "label": "Note for these records",
                  "name": "note",
                  "placeholder": "e.g. Check North America's growth",
                  "required": true,
                  "type": "text",
                },
              ],
              "submitLabel": "Save",
              "successMessage": "Note saved (the table was refetched at the latest data version).",
            },
            "type": "presentForm",
          },
          {
            "data": {
              "$ref": "query://sales/records",
            },
            "id": "g",
            "props": {
              "editable": false,
              "pageSize": 100,
              "serverSide": true,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "openNote.press",
            "payload": {
              "key": "noteOpen",
              "value": true,
            },
          },
          {
            "emit": "state.set",
            "on": "noteDialog.close",
            "payload": {
              "key": "noteOpen",
              "value": false,
            },
          },
          {
            "emit": "action.invoke",
            "on": "noteForm.submit",
            "payload": {
              "note": "$value.note",
              "refs": [
                "query://sales/records",
              ],
            },
          },
        ],
        "intent": {
          "canonical": "sales.records",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {},
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "noteOpen": false,
        },
      }
    `);
  });
  it("ja: empty scope (no fiscalYear, no quarter, no region), default limit", async () => {
    const spec = await build("ja", intent("sales.records", {}), refs("query://sales/records"));
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "openNote",
              "noteDialog",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "売上明細(全期間)",
            },
            "type": "text.heading",
          },
          {
            "id": "openNote",
            "props": {
              "label": "メモを追加",
              "variant": "secondary",
            },
            "type": "action.button",
          },
          {
            "children": [
              "noteForm",
            ],
            "id": "noteDialog",
            "props": {
              "description": "書き込みは part → API へ直接(capability トークン付き)行われ、LLM のコンテキストを経由しません。",
              "title": "この明細にメモを追加",
            },
            "type": "overlay.dialog",
            "visibleWhen": {
              "eq": true,
              "ref": "$state.noteOpen",
            },
          },
          {
            "id": "noteForm",
            "props": {
              "action": "annotate",
              "fields": [
                {
                  "label": "この明細へのメモ",
                  "name": "note",
                  "placeholder": "例: 北米の成長を確認",
                  "required": true,
                  "type": "text",
                },
              ],
              "submitLabel": "保存",
              "successMessage": "メモを保存しました(表は最新のデータバージョンで再取得されました)。",
            },
            "type": "presentForm",
          },
          {
            "data": {
              "$ref": "query://sales/records",
            },
            "id": "g",
            "props": {
              "editable": false,
              "pageSize": 100,
              "serverSide": true,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "openNote.press",
            "payload": {
              "key": "noteOpen",
              "value": true,
            },
          },
          {
            "emit": "state.set",
            "on": "noteDialog.close",
            "payload": {
              "key": "noteOpen",
              "value": false,
            },
          },
          {
            "emit": "action.invoke",
            "on": "noteForm.submit",
            "payload": {
              "note": "$value.note",
              "refs": [
                "query://sales/records",
              ],
            },
          },
        ],
        "intent": {
          "canonical": "sales.records",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {},
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "noteOpen": false,
        },
      }
    `);
  });

  it("en: limit 500 clamps pageSize to the serverSide upper bound", async () => {
    const spec = await build(
      "en",
      intent("sales.records", { limit: 500 }),
      refs("query://sales/records?limit=500"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "openNote",
              "noteDialog",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "Sales Records (All periods)",
            },
            "type": "text.heading",
          },
          {
            "id": "openNote",
            "props": {
              "label": "Add a note",
              "variant": "secondary",
            },
            "type": "action.button",
          },
          {
            "children": [
              "noteForm",
            ],
            "id": "noteDialog",
            "props": {
              "description": "Writes go part → API directly (with a capability token) and never pass through the LLM's context.",
              "title": "Add a note to these records",
            },
            "type": "overlay.dialog",
            "visibleWhen": {
              "eq": true,
              "ref": "$state.noteOpen",
            },
          },
          {
            "id": "noteForm",
            "props": {
              "action": "annotate",
              "fields": [
                {
                  "label": "Note for these records",
                  "name": "note",
                  "placeholder": "e.g. Check North America's growth",
                  "required": true,
                  "type": "text",
                },
              ],
              "submitLabel": "Save",
              "successMessage": "Note saved (the table was refetched at the latest data version).",
            },
            "type": "presentForm",
          },
          {
            "data": {
              "$ref": "query://sales/records?limit=500",
            },
            "id": "g",
            "props": {
              "editable": false,
              "pageSize": 500,
              "serverSide": true,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [
          {
            "emit": "state.set",
            "on": "openNote.press",
            "payload": {
              "key": "noteOpen",
              "value": true,
            },
          },
          {
            "emit": "state.set",
            "on": "noteDialog.close",
            "payload": {
              "key": "noteOpen",
              "value": false,
            },
          },
          {
            "emit": "action.invoke",
            "on": "noteForm.submit",
            "payload": {
              "note": "$value.note",
              "refs": [
                "query://sales/records?limit=500",
              ],
            },
          },
        ],
        "intent": {
          "canonical": "sales.records",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "limit": 500,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
        "state": {
          "noteOpen": false,
        },
      }
    `);
  });
});

describe("fixed-specs snapshot: sales.target_attainment", () => {
  it("en: fiscalYear + quarter", async () => {
    const spec = await build(
      "en",
      intent("sales.target_attainment", { fiscalYear: 2026, quarter: 2 }),
      refs("query://sales/targets?fy=2026&q=2", "query://sales/kpi?fy=2026&metric=target_attainment&q=2"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "k",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "FY2026 Q2 Target Attainment",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
            },
            "id": "k",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/targets?fy=2026&q=2",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": [
                "actual",
                "target",
              ],
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/targets?fy=2026&q=2",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.target_attainment",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "quarter": 2,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
  it("ja: fiscalYear + quarter", async () => {
    const spec = await build(
      "ja",
      intent("sales.target_attainment", { fiscalYear: 2026, quarter: 2 }),
      refs("query://sales/targets?fy=2026&q=2", "query://sales/kpi?fy=2026&metric=target_attainment&q=2"),
    );
    expect(spec).toMatchInlineSnapshot(`
      {
        "components": [
          {
            "children": [
              "t",
              "k",
              "c",
              "g",
            ],
            "id": "root",
            "props": {
              "direction": "vertical",
              "gap": "md",
            },
            "type": "layout.stack",
          },
          {
            "id": "t",
            "props": {
              "level": 2,
              "text": "2026年度Q2 目標達成",
            },
            "type": "text.heading",
          },
          {
            "data": {
              "$ref": "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
            },
            "id": "k",
            "props": {},
            "type": "sales.kpiCard",
          },
          {
            "data": {
              "$ref": "query://sales/targets?fy=2026&q=2",
            },
            "id": "c",
            "props": {
              "kind": "bar",
              "x": "region",
              "y": [
                "actual",
                "target",
              ],
            },
            "type": "presentChart",
          },
          {
            "data": {
              "$ref": "query://sales/targets?fy=2026&q=2",
            },
            "id": "g",
            "props": {
              "editable": false,
            },
            "type": "presentSpreadsheet",
          },
        ],
        "dataVersion": "template",
        "events": [],
        "intent": {
          "canonical": "sales.target_attainment",
          "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          "params": {
            "fiscalYear": 2026,
            "quarter": 2,
          },
        },
        "kohaku": "0.2",
        "provenance": {
          "cache": "miss",
          "composedBy": "fixed-spec-template",
          "tier": "L0",
        },
      }
    `);
  });
});

describe("fixed-specs snapshot: unmapped intent", () => {
  it("lookup returns null for an intent with no fixed spec (e.g. sales.trend)", async () => {
    const source = createFixedSpecs("en");
    const builder = await source.lookup(intent("sales.trend", { fiscalYear: 2026 }));
    expect(builder).toBeNull();
  });
});

// Pins domain/queries.ts's groupLabel() (currently private) via the public summary() column labels —
// the label is exposed as columns[0].label on the aggregated result. Consolidating this with
// fixed-specs.ts's GROUP_LABELS (Step 2 of the refactor) must not change any of these three labels.
describe("groupLabel snapshot (via domain/queries.ts summary() column labels)", () => {
  const repo = new SalesRepo();

  it("region", () => {
    const t = summary(repo, { groupBy: "region" });
    expect(t.columns[0]!.label).toMatchInlineSnapshot(`"Region"`);
  });

  it("product", () => {
    const t = summary(repo, { groupBy: "product" });
    expect(t.columns[0]!.label).toMatchInlineSnapshot(`"Product"`);
  });

  it("channel", () => {
    const t = summary(repo, { groupBy: "channel" });
    expect(t.columns[0]!.label).toMatchInlineSnapshot(`"Channel"`);
  });
});
