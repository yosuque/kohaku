import type { IntentDef } from "@kohaku-ui/intents";
import { defineIntent } from "@kohaku-ui/intents";
import type { JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createIntentCatalog, type IntentCatalogLike, renderCatalogDoc } from "../src/index.js";

const summary = defineIntent({
  canonical: "sales.summary",
  description: "Summary",
  source: "sales",
  params: z.object({}),
  examples: [],
  queries: [],
}).toIntentDef();

const promoted = defineIntent({
  canonical: "sales.promoted",
  description: "A promoted Intent",
  source: "sales",
  params: z.object({}),
  examples: [],
  queries: [],
}).toIntentDef();

describe("renderCatalogDoc: revision-aware caching", () => {
  it("recomputes after catalog.add mutates the same object (revision bumped)", () => {
    const catalog = createIntentCatalog([summary]);
    const before = renderCatalogDoc(catalog);
    expect(before).not.toContain("sales.promoted");

    catalog.add(promoted);
    const after = renderCatalogDoc(catalog);
    expect(after).toContain("### sales.promoted\nA promoted Intent");
  });

  it("recomputes after catalog.remove mutates the same object", () => {
    const catalog = createIntentCatalog([summary, promoted]);
    const before = renderCatalogDoc(catalog);
    expect(before).toContain("sales.promoted");

    catalog.remove("sales.promoted");
    const after = renderCatalogDoc(catalog);
    expect(after).not.toContain("sales.promoted");
  });

  it("a catalog without a revision is still memoized purely on object identity", () => {
    let listCalls = 0;
    const stub: IntentCatalogLike = {
      get: () => undefined,
      list(): IntentDef[] {
        listCalls++;
        return [summary];
      },
      names: () => ["sales.summary"],
      normalizeParams: (_name: string, params: JsonObject) => params,
      // no `revision` field: an immutable / revision-less IntentCatalogLike implementation.
    };
    const first = renderCatalogDoc(stub);
    const second = renderCatalogDoc(stub);
    expect(second).toBe(first);
    expect(listCalls).toBe(1);
  });
});
