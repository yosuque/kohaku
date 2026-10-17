import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type ComposeContext,
  type ComposeErrorContext,
  type ComposeOptions,
  type ComposePolicy,
  type ComposeTrace,
  compose,
  composeObservers,
  DEFAULT_KIT_VOCABULARY,
} from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

/**
 * Characterization of the L0 (fixed-spec) delivery next to the L1 delivery, pinned BEFORE the L0 path is
 * routed through the shared tail (assemble -> post-process -> cache store -> trace) that the L1/L2 path
 * uses. It records what the code does today, not what it should do: provenance, the full trace, the exact
 * putSpecCache arguments, the observer-context objects and the budget usage hook, for the default, bypass
 * and cache-put-failure paths. Wall-clock durationMs is zeroed; everything else is exact.
 *
 * Each scenario observes both tiers into one object and snapshots it once: an inline snapshot call site
 * must hold a single value, so a describe.each over the tier would not work.
 */

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

const WITH_IDENTITY: ComposeOptions = {
  correlationId: "corr-char-1",
  traceContext: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "k=v" },
};

const FIXED: UISpec = {
  kohaku: "0.1",
  intent: { canonical: "x.y", params: {}, hash: `sha256:${"0".repeat(64)}` },
  dataVersion: "ignored",
  components: [
    { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
    { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
  ],
  events: [],
  state: { open: true },
  provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
};

type Tier = "L0" | "L1";

/** Observer hooks are fire-and-forget; let them land before reading what they collected. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wall-clock information is the only non-deterministic part of a trace. */
function norm(trace: ComposeTrace): ComposeTrace {
  return { ...trace, durationMs: 0 };
}

interface Observed {
  provenance: UISpec["provenance"];
  trace: ComposeTrace;
  traceKeys: string[];
  puts: unknown[][];
  composed: { trace: ComposeTrace; spec: UISpec }[];
  errors: { ctx: ComposeErrorContext; errorMessage: string | undefined; contextKeys: string[] }[];
  usages: unknown[];
}

/** Composes one intent on the given tier (L0 via fixedSpecs, L1 via a scripted draft) and records what it did. */
async function observe(
  tier: Tier,
  scenario: { policy?: ComposePolicy; failPut?: boolean; opts?: ComposeOptions } = {},
): Promise<Observed> {
  const puts: unknown[][] = [];
  const composed: Observed["composed"] = [];
  const errors: Observed["errors"] = [];
  const usages: unknown[] = [];
  const base = makeStorage();
  const storage: StoragePort = {
    ...base,
    async putSpecCache(...args: Parameters<StoragePort["putSpecCache"]>) {
      puts.push([...args]);
      if (scenario.failPut === true) throw new Error("cache backend down");
      return base.putSpecCache(...args);
    },
  };
  const policy: ComposePolicy = {
    // generatorVersion and the kit exercise provenanceStampsOf on both paths.
    generatorVersion: "gv-char",
    designSystem: { kit: DEFAULT_KIT_VOCABULARY },
    ...(tier === "L0" ? { fixedSpecs: { lookup: async () => FIXED } } : {}),
    budget: { onUsage: (info) => void usages.push(info) },
    ...scenario.policy,
  };
  const ctx: ComposeContext = {
    catalog,
    semantic: makeSemantic(),
    storage,
    llm: new FakeLlm({ objects: [goodRawDraft()] }),
    policy,
    observer: composeObservers({
      onComposed: (trace, spec) => void composed.push({ trace: norm(trace), spec }),
      onError: (errCtx, error) =>
        void errors.push({
          ctx: errCtx,
          errorMessage: error instanceof Error ? error.message : undefined,
          contextKeys: Object.keys(errCtx),
        }),
    }),
  };
  const result = await compose(GUI_INPUT, ctx, scenario.opts);
  await flush();
  // The delivered Spec is exactly what was stored (when anything was).
  if (puts.length > 0) expect(puts[0]![1]).toEqual(result.spec);
  return {
    provenance: result.spec.provenance,
    trace: norm(result.trace),
    traceKeys: Object.keys(result.trace),
    puts,
    composed,
    errors,
    usages,
  };
}

describe("L0 vs L1 delivery characterization", () => {
  it("default cache mode", async () => {
    const observed = {
      L0: await observe("L0", { opts: WITH_IDENTITY }),
      L1: await observe("L1", { opts: WITH_IDENTITY }),
    };
    expect(observed).toMatchInlineSnapshot(`
      {
        "L0": {
          "composed": [
            {
              "spec": {
                "components": [
                  {
                    "children": [
                      "md1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "md1",
                    "props": {
                      "markdown": "Pinned view",
                    },
                    "type": "presentMarkdown",
                    "version": "1.0.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "tier": "L0",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
                "state": {
                  "open": true,
                },
              },
              "trace": {
                "attempts": [],
                "cache": "miss",
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "cacheKeyParts": {
                  "catalogFingerprint": "613c927375d8b18a",
                  "dataVersion": "sales@seed-1",
                  "generatorVersion": "gv-char",
                  "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "policyFingerprint": "1e12b4ee8f905503",
                  "specVersion": "0.2",
                },
                "correlationId": "corr-char-1",
                "dataVersion": "sales@seed-1",
                "durationMs": 0,
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "refs": [
                  "query://sales/summary?fy=2026&groupBy=region&q=3",
                ],
                "tier": "L0",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
              },
            },
          ],
          "errors": [],
          "provenance": {
            "cache": "miss",
            "composedBy": "composer@0.1.0",
            "generatorVersion": "gv-char",
            "kit": {
              "id": "kohaku",
              "version": "1",
            },
            "tier": "L0",
          },
          "puts": [
            [
              "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
              {
                "components": [
                  {
                    "children": [
                      "md1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "md1",
                    "props": {
                      "markdown": "Pinned view",
                    },
                    "type": "presentMarkdown",
                    "version": "1.0.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "tier": "L0",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
                "state": {
                  "open": true,
                },
              },
              undefined,
            ],
          ],
          "trace": {
            "attempts": [],
            "cache": "miss",
            "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
            "cacheKeyParts": {
              "catalogFingerprint": "613c927375d8b18a",
              "dataVersion": "sales@seed-1",
              "generatorVersion": "gv-char",
              "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "policyFingerprint": "1e12b4ee8f905503",
              "specVersion": "0.2",
            },
            "correlationId": "corr-char-1",
            "dataVersion": "sales@seed-1",
            "durationMs": 0,
            "input": {
              "action": "facet.change",
              "kind": "gui",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "intent": {
              "canonical": "sales.quarterly_summary",
              "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "refs": [
              "query://sales/summary?fy=2026&groupBy=region&q=3",
            ],
            "tier": "L0",
            "traceContext": {
              "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
              "tracestate": "k=v",
            },
          },
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "correlationId",
            "traceContext",
            "cache",
            "tier",
            "attempts",
            "durationMs",
          ],
          "usages": [],
        },
        "L1": {
          "composed": [
            {
              "spec": {
                "components": [
                  {
                    "children": [
                      "title1",
                      "chart1",
                      "table1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "title1",
                    "props": {
                      "level": 2,
                      "text": "FY2026 Q3 Sales (by region)",
                    },
                    "type": "text.heading",
                    "version": "1.0.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "chart1",
                    "props": {
                      "kind": "bar",
                      "x": "region",
                      "y": "revenue",
                    },
                    "type": "presentChart",
                    "version": "1.1.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "table1",
                    "props": {
                      "editable": false,
                      "serverSide": false,
                      "sortBy": {
                        "dir": "desc",
                        "field": "revenue",
                      },
                    },
                    "type": "presentSpreadsheet",
                    "version": "1.1.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [
                  {
                    "emit": "intent.patch",
                    "on": "table1.rowClick",
                    "payload": {
                      "drilldown": "$row.region",
                    },
                  },
                ],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "model": "fake-model",
                  "tier": "L1",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
              },
              "trace": {
                "attempts": [
                  {
                    "kind": "l1",
                    "ok": true,
                    "usage": {
                      "inputTokens": 0,
                      "outputTokens": 0,
                    },
                  },
                ],
                "cache": "miss",
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "cacheKeyParts": {
                  "catalogFingerprint": "613c927375d8b18a",
                  "dataVersion": "sales@seed-1",
                  "generatorVersion": "gv-char",
                  "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "policyFingerprint": "1e12b4ee8f905503",
                  "specVersion": "0.2",
                },
                "correlationId": "corr-char-1",
                "dataVersion": "sales@seed-1",
                "durationMs": 0,
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "model": "fake-model",
                "refs": [
                  "query://sales/summary?fy=2026&groupBy=region&q=3",
                ],
                "tier": "L1",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
                "usage": {
                  "inputTokens": 0,
                  "outputTokens": 0,
                },
              },
            },
          ],
          "errors": [],
          "provenance": {
            "cache": "miss",
            "composedBy": "composer@0.1.0",
            "generatorVersion": "gv-char",
            "kit": {
              "id": "kohaku",
              "version": "1",
            },
            "model": "fake-model",
            "tier": "L1",
          },
          "puts": [
            [
              "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
              {
                "components": [
                  {
                    "children": [
                      "title1",
                      "chart1",
                      "table1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "title1",
                    "props": {
                      "level": 2,
                      "text": "FY2026 Q3 Sales (by region)",
                    },
                    "type": "text.heading",
                    "version": "1.0.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "chart1",
                    "props": {
                      "kind": "bar",
                      "x": "region",
                      "y": "revenue",
                    },
                    "type": "presentChart",
                    "version": "1.1.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "table1",
                    "props": {
                      "editable": false,
                      "serverSide": false,
                      "sortBy": {
                        "dir": "desc",
                        "field": "revenue",
                      },
                    },
                    "type": "presentSpreadsheet",
                    "version": "1.1.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [
                  {
                    "emit": "intent.patch",
                    "on": "table1.rowClick",
                    "payload": {
                      "drilldown": "$row.region",
                    },
                  },
                ],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "model": "fake-model",
                  "tier": "L1",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
              },
              undefined,
            ],
          ],
          "trace": {
            "attempts": [
              {
                "kind": "l1",
                "ok": true,
                "usage": {
                  "inputTokens": 0,
                  "outputTokens": 0,
                },
              },
            ],
            "cache": "miss",
            "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
            "cacheKeyParts": {
              "catalogFingerprint": "613c927375d8b18a",
              "dataVersion": "sales@seed-1",
              "generatorVersion": "gv-char",
              "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "policyFingerprint": "1e12b4ee8f905503",
              "specVersion": "0.2",
            },
            "correlationId": "corr-char-1",
            "dataVersion": "sales@seed-1",
            "durationMs": 0,
            "input": {
              "action": "facet.change",
              "kind": "gui",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "intent": {
              "canonical": "sales.quarterly_summary",
              "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "model": "fake-model",
            "refs": [
              "query://sales/summary?fy=2026&groupBy=region&q=3",
            ],
            "tier": "L1",
            "traceContext": {
              "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
              "tracestate": "k=v",
            },
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
            },
          },
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "correlationId",
            "traceContext",
            "cache",
            "tier",
            "attempts",
            "model",
            "usage",
            "durationMs",
          ],
          "usages": [
            {
              "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
              },
            },
          ],
        },
      }
    `);
  });

  it("bypass cache mode stores nothing and labels the delivery bypass", async () => {
    const scenario = { policy: { cacheMode: "bypass" as const }, opts: WITH_IDENTITY };
    const observed = { L0: await observe("L0", scenario), L1: await observe("L1", scenario) };
    expect(observed).toMatchInlineSnapshot(`
      {
        "L0": {
          "composed": [
            {
              "spec": {
                "components": [
                  {
                    "children": [
                      "md1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "md1",
                    "props": {
                      "markdown": "Pinned view",
                    },
                    "type": "presentMarkdown",
                    "version": "1.0.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "bypass",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "tier": "L0",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
                "state": {
                  "open": true,
                },
              },
              "trace": {
                "attempts": [],
                "cache": "bypass",
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "cacheKeyParts": {
                  "catalogFingerprint": "613c927375d8b18a",
                  "dataVersion": "sales@seed-1",
                  "generatorVersion": "gv-char",
                  "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "policyFingerprint": "1e12b4ee8f905503",
                  "specVersion": "0.2",
                },
                "correlationId": "corr-char-1",
                "dataVersion": "sales@seed-1",
                "durationMs": 0,
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "refs": [
                  "query://sales/summary?fy=2026&groupBy=region&q=3",
                ],
                "tier": "L0",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
              },
            },
          ],
          "errors": [],
          "provenance": {
            "cache": "bypass",
            "composedBy": "composer@0.1.0",
            "generatorVersion": "gv-char",
            "kit": {
              "id": "kohaku",
              "version": "1",
            },
            "tier": "L0",
          },
          "puts": [],
          "trace": {
            "attempts": [],
            "cache": "bypass",
            "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
            "cacheKeyParts": {
              "catalogFingerprint": "613c927375d8b18a",
              "dataVersion": "sales@seed-1",
              "generatorVersion": "gv-char",
              "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "policyFingerprint": "1e12b4ee8f905503",
              "specVersion": "0.2",
            },
            "correlationId": "corr-char-1",
            "dataVersion": "sales@seed-1",
            "durationMs": 0,
            "input": {
              "action": "facet.change",
              "kind": "gui",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "intent": {
              "canonical": "sales.quarterly_summary",
              "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "refs": [
              "query://sales/summary?fy=2026&groupBy=region&q=3",
            ],
            "tier": "L0",
            "traceContext": {
              "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
              "tracestate": "k=v",
            },
          },
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "correlationId",
            "traceContext",
            "cache",
            "tier",
            "attempts",
            "durationMs",
          ],
          "usages": [],
        },
        "L1": {
          "composed": [
            {
              "spec": {
                "components": [
                  {
                    "children": [
                      "title1",
                      "chart1",
                      "table1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "title1",
                    "props": {
                      "level": 2,
                      "text": "FY2026 Q3 Sales (by region)",
                    },
                    "type": "text.heading",
                    "version": "1.0.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "chart1",
                    "props": {
                      "kind": "bar",
                      "x": "region",
                      "y": "revenue",
                    },
                    "type": "presentChart",
                    "version": "1.1.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "table1",
                    "props": {
                      "editable": false,
                      "serverSide": false,
                      "sortBy": {
                        "dir": "desc",
                        "field": "revenue",
                      },
                    },
                    "type": "presentSpreadsheet",
                    "version": "1.1.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [
                  {
                    "emit": "intent.patch",
                    "on": "table1.rowClick",
                    "payload": {
                      "drilldown": "$row.region",
                    },
                  },
                ],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "bypass",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "model": "fake-model",
                  "tier": "L1",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
              },
              "trace": {
                "attempts": [
                  {
                    "kind": "l1",
                    "ok": true,
                    "usage": {
                      "inputTokens": 0,
                      "outputTokens": 0,
                    },
                  },
                ],
                "cache": "bypass",
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "cacheKeyParts": {
                  "catalogFingerprint": "613c927375d8b18a",
                  "dataVersion": "sales@seed-1",
                  "generatorVersion": "gv-char",
                  "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "policyFingerprint": "1e12b4ee8f905503",
                  "specVersion": "0.2",
                },
                "correlationId": "corr-char-1",
                "dataVersion": "sales@seed-1",
                "durationMs": 0,
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "model": "fake-model",
                "refs": [
                  "query://sales/summary?fy=2026&groupBy=region&q=3",
                ],
                "tier": "L1",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
                "usage": {
                  "inputTokens": 0,
                  "outputTokens": 0,
                },
              },
            },
          ],
          "errors": [],
          "provenance": {
            "cache": "bypass",
            "composedBy": "composer@0.1.0",
            "generatorVersion": "gv-char",
            "kit": {
              "id": "kohaku",
              "version": "1",
            },
            "model": "fake-model",
            "tier": "L1",
          },
          "puts": [],
          "trace": {
            "attempts": [
              {
                "kind": "l1",
                "ok": true,
                "usage": {
                  "inputTokens": 0,
                  "outputTokens": 0,
                },
              },
            ],
            "cache": "bypass",
            "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
            "cacheKeyParts": {
              "catalogFingerprint": "613c927375d8b18a",
              "dataVersion": "sales@seed-1",
              "generatorVersion": "gv-char",
              "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "policyFingerprint": "1e12b4ee8f905503",
              "specVersion": "0.2",
            },
            "correlationId": "corr-char-1",
            "dataVersion": "sales@seed-1",
            "durationMs": 0,
            "input": {
              "action": "facet.change",
              "kind": "gui",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "intent": {
              "canonical": "sales.quarterly_summary",
              "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "model": "fake-model",
            "refs": [
              "query://sales/summary?fy=2026&groupBy=region&q=3",
            ],
            "tier": "L1",
            "traceContext": {
              "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
              "tracestate": "k=v",
            },
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
            },
          },
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "correlationId",
            "traceContext",
            "cache",
            "tier",
            "attempts",
            "model",
            "usage",
            "durationMs",
          ],
          "usages": [
            {
              "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
              },
            },
          ],
        },
      }
    `);
  });

  it("a failing cache put is fail-open and reports the cache error context", async () => {
    const scenario = { failPut: true, opts: WITH_IDENTITY };
    const observed = { L0: await observe("L0", scenario), L1: await observe("L1", scenario) };
    expect(observed).toMatchInlineSnapshot(`
      {
        "L0": {
          "composed": [
            {
              "spec": {
                "components": [
                  {
                    "children": [
                      "md1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "md1",
                    "props": {
                      "markdown": "Pinned view",
                    },
                    "type": "presentMarkdown",
                    "version": "1.0.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "tier": "L0",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
                "state": {
                  "open": true,
                },
              },
              "trace": {
                "attempts": [],
                "cache": "miss",
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "cacheKeyParts": {
                  "catalogFingerprint": "613c927375d8b18a",
                  "dataVersion": "sales@seed-1",
                  "generatorVersion": "gv-char",
                  "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "policyFingerprint": "1e12b4ee8f905503",
                  "specVersion": "0.2",
                },
                "correlationId": "corr-char-1",
                "dataVersion": "sales@seed-1",
                "durationMs": 0,
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "refs": [
                  "query://sales/summary?fy=2026&groupBy=region&q=3",
                ],
                "tier": "L0",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
              },
            },
          ],
          "errors": [
            {
              "contextKeys": [
                "phase",
                "input",
                "intent",
                "cacheKey",
                "correlationId",
                "traceContext",
              ],
              "ctx": {
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "correlationId": "corr-char-1",
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "phase": "cache",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
              },
              "errorMessage": "cache backend down",
            },
          ],
          "provenance": {
            "cache": "miss",
            "composedBy": "composer@0.1.0",
            "generatorVersion": "gv-char",
            "kit": {
              "id": "kohaku",
              "version": "1",
            },
            "tier": "L0",
          },
          "puts": [
            [
              "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
              {
                "components": [
                  {
                    "children": [
                      "md1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "md1",
                    "props": {
                      "markdown": "Pinned view",
                    },
                    "type": "presentMarkdown",
                    "version": "1.0.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "tier": "L0",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
                "state": {
                  "open": true,
                },
              },
              undefined,
            ],
          ],
          "trace": {
            "attempts": [],
            "cache": "miss",
            "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
            "cacheKeyParts": {
              "catalogFingerprint": "613c927375d8b18a",
              "dataVersion": "sales@seed-1",
              "generatorVersion": "gv-char",
              "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "policyFingerprint": "1e12b4ee8f905503",
              "specVersion": "0.2",
            },
            "correlationId": "corr-char-1",
            "dataVersion": "sales@seed-1",
            "durationMs": 0,
            "input": {
              "action": "facet.change",
              "kind": "gui",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "intent": {
              "canonical": "sales.quarterly_summary",
              "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "refs": [
              "query://sales/summary?fy=2026&groupBy=region&q=3",
            ],
            "tier": "L0",
            "traceContext": {
              "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
              "tracestate": "k=v",
            },
          },
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "correlationId",
            "traceContext",
            "cache",
            "tier",
            "attempts",
            "durationMs",
          ],
          "usages": [],
        },
        "L1": {
          "composed": [
            {
              "spec": {
                "components": [
                  {
                    "children": [
                      "title1",
                      "chart1",
                      "table1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "title1",
                    "props": {
                      "level": 2,
                      "text": "FY2026 Q3 Sales (by region)",
                    },
                    "type": "text.heading",
                    "version": "1.0.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "chart1",
                    "props": {
                      "kind": "bar",
                      "x": "region",
                      "y": "revenue",
                    },
                    "type": "presentChart",
                    "version": "1.1.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "table1",
                    "props": {
                      "editable": false,
                      "serverSide": false,
                      "sortBy": {
                        "dir": "desc",
                        "field": "revenue",
                      },
                    },
                    "type": "presentSpreadsheet",
                    "version": "1.1.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [
                  {
                    "emit": "intent.patch",
                    "on": "table1.rowClick",
                    "payload": {
                      "drilldown": "$row.region",
                    },
                  },
                ],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "model": "fake-model",
                  "tier": "L1",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
              },
              "trace": {
                "attempts": [
                  {
                    "kind": "l1",
                    "ok": true,
                    "usage": {
                      "inputTokens": 0,
                      "outputTokens": 0,
                    },
                  },
                ],
                "cache": "miss",
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "cacheKeyParts": {
                  "catalogFingerprint": "613c927375d8b18a",
                  "dataVersion": "sales@seed-1",
                  "generatorVersion": "gv-char",
                  "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "policyFingerprint": "1e12b4ee8f905503",
                  "specVersion": "0.2",
                },
                "correlationId": "corr-char-1",
                "dataVersion": "sales@seed-1",
                "durationMs": 0,
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "model": "fake-model",
                "refs": [
                  "query://sales/summary?fy=2026&groupBy=region&q=3",
                ],
                "tier": "L1",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
                "usage": {
                  "inputTokens": 0,
                  "outputTokens": 0,
                },
              },
            },
          ],
          "errors": [
            {
              "contextKeys": [
                "phase",
                "input",
                "intent",
                "cacheKey",
                "correlationId",
                "traceContext",
              ],
              "ctx": {
                "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
                "correlationId": "corr-char-1",
                "input": {
                  "action": "facet.change",
                  "kind": "gui",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "phase": "cache",
                "traceContext": {
                  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                  "tracestate": "k=v",
                },
              },
              "errorMessage": "cache backend down",
            },
          ],
          "provenance": {
            "cache": "miss",
            "composedBy": "composer@0.1.0",
            "generatorVersion": "gv-char",
            "kit": {
              "id": "kohaku",
              "version": "1",
            },
            "model": "fake-model",
            "tier": "L1",
          },
          "puts": [
            [
              "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
              {
                "components": [
                  {
                    "children": [
                      "title1",
                      "chart1",
                      "table1",
                    ],
                    "id": "root",
                    "props": {
                      "direction": "vertical",
                      "gap": "md",
                    },
                    "type": "layout.stack",
                    "version": "1.0.0",
                  },
                  {
                    "id": "title1",
                    "props": {
                      "level": 2,
                      "text": "FY2026 Q3 Sales (by region)",
                    },
                    "type": "text.heading",
                    "version": "1.0.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "chart1",
                    "props": {
                      "kind": "bar",
                      "x": "region",
                      "y": "revenue",
                    },
                    "type": "presentChart",
                    "version": "1.1.0",
                  },
                  {
                    "data": {
                      "$ref": "query://sales/summary?fy=2026&groupBy=region&q=3",
                    },
                    "id": "table1",
                    "props": {
                      "editable": false,
                      "serverSide": false,
                      "sortBy": {
                        "dir": "desc",
                        "field": "revenue",
                      },
                    },
                    "type": "presentSpreadsheet",
                    "version": "1.1.0",
                  },
                ],
                "dataVersion": "sales@seed-1",
                "events": [
                  {
                    "emit": "intent.patch",
                    "on": "table1.rowClick",
                    "payload": {
                      "drilldown": "$row.region",
                    },
                  },
                ],
                "intent": {
                  "canonical": "sales.quarterly_summary",
                  "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
                  "params": {
                    "fiscalYear": 2026,
                    "groupBy": "region",
                    "quarter": 3,
                  },
                },
                "kohaku": "0.2",
                "provenance": {
                  "cache": "miss",
                  "composedBy": "composer@0.1.0",
                  "generatorVersion": "gv-char",
                  "kit": {
                    "id": "kohaku",
                    "version": "1",
                  },
                  "model": "fake-model",
                  "tier": "L1",
                },
                "refVersions": {
                  "query://sales/summary?fy=2026&groupBy=region&q=3": "sales@seed-1",
                },
              },
              undefined,
            ],
          ],
          "trace": {
            "attempts": [
              {
                "kind": "l1",
                "ok": true,
                "usage": {
                  "inputTokens": 0,
                  "outputTokens": 0,
                },
              },
            ],
            "cache": "miss",
            "cacheKey": "kohaku:0.2:sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5:sales@seed-1:613c927375d8b18a:gv-char:1e12b4ee8f905503",
            "cacheKeyParts": {
              "catalogFingerprint": "613c927375d8b18a",
              "dataVersion": "sales@seed-1",
              "generatorVersion": "gv-char",
              "intentHash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "policyFingerprint": "1e12b4ee8f905503",
              "specVersion": "0.2",
            },
            "correlationId": "corr-char-1",
            "dataVersion": "sales@seed-1",
            "durationMs": 0,
            "input": {
              "action": "facet.change",
              "kind": "gui",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "intent": {
              "canonical": "sales.quarterly_summary",
              "hash": "sha256:13ea0aa388f2425c7fef6dc5dab22f96fe0f7ff1178066142497eafea6bbced5",
              "params": {
                "fiscalYear": 2026,
                "groupBy": "region",
                "quarter": 3,
              },
            },
            "model": "fake-model",
            "refs": [
              "query://sales/summary?fy=2026&groupBy=region&q=3",
            ],
            "tier": "L1",
            "traceContext": {
              "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
              "tracestate": "k=v",
            },
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
            },
          },
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "correlationId",
            "traceContext",
            "cache",
            "tier",
            "attempts",
            "model",
            "usage",
            "durationMs",
          ],
          "usages": [
            {
              "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
              },
            },
          ],
        },
      }
    `);
  });

  it("without correlationId / traceContext neither the trace nor the error context carries the keys", async () => {
    const scenario = { failPut: true };
    const observed = { L0: await observe("L0", scenario), L1: await observe("L1", scenario) };
    expect({
      L0: {
        traceKeys: observed.L0.traceKeys,
        errorContextKeys: observed.L0.errors.map((e) => e.contextKeys),
      },
      L1: {
        traceKeys: observed.L1.traceKeys,
        errorContextKeys: observed.L1.errors.map((e) => e.contextKeys),
      },
    }).toMatchInlineSnapshot(`
      {
        "L0": {
          "errorContextKeys": [
            [
              "phase",
              "input",
              "intent",
              "cacheKey",
            ],
          ],
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "cache",
            "tier",
            "attempts",
            "durationMs",
          ],
        },
        "L1": {
          "errorContextKeys": [
            [
              "phase",
              "input",
              "intent",
              "cacheKey",
            ],
          ],
          "traceKeys": [
            "input",
            "intent",
            "refs",
            "dataVersion",
            "cacheKey",
            "cacheKeyParts",
            "cache",
            "tier",
            "attempts",
            "model",
            "usage",
            "durationMs",
          ],
        },
      }
    `);
  });
});
