import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTED_SPEC_VERSIONS,
  applyPatch,
  canonicalStringify,
  computeIntentHash,
  diffSpec,
  parseSpec,
  safeParseSpec,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { ConformanceResult } from "./types.js";

const EXAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../examples/quarterly-sales.spec.json");

/** Self-check of the Spec format (a self suite using the reference implementation spec-core). */
export async function runSpecFormatSuite(): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8")) as UISpec;

  results.push(
    check("SPEC-ENV-001", () => {
      const spec = parseSpec(example);
      // Accepted versions are {0.1, 0.2}. Confirm the envelope carries a version string.
      return (
        (ACCEPTED_SPEC_VERSIONS as readonly string[]).includes(spec.kohaku) ||
        `unexpected version ${spec.kohaku}`
      );
    }),
  );

  results.push(
    await checkAsync("SPEC-ENV-002", async () => {
      const spec = parseSpec(example);
      const hash = await computeIntentHash({ canonical: spec.intent.canonical, params: spec.intent.params });
      return hash === spec.intent.hash || `hash mismatch: ${hash} != ${spec.intent.hash}`;
    }),
  );

  results.push(
    check("SPEC-CMP-001", () => {
      const dup = safeParseSpec({
        ...example,
        components: [
          { id: "root", type: "layout.stack", props: {} },
          { id: "root", type: "text.heading", props: {} },
        ],
        events: [],
      });
      const noRoot = safeParseSpec({
        ...example,
        components: [{ id: "a", type: "layout.stack", props: {} }],
        events: [],
      });
      return (!dup.ok && !noRoot.ok) || "duplicate id / missing root is not rejected";
    }),
  );

  results.push(
    check("SPEC-CMP-002", () => {
      const cyclic = safeParseSpec({
        ...example,
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["a"] },
          { id: "a", type: "layout.stack", props: {}, children: ["root"] },
        ],
        events: [],
      });
      return !cyclic.ok || "a cyclic reference is not rejected";
    }),
  );

  results.push(
    check("SPEC-DATA-001", () => {
      // A node that mixes bulk data (rows) alongside a valid $ref must be rejected.
      // Simply omitting $ref would only fail on "$ref required" and would not exercise bulk-embedding detection.
      const bulkWithRef = safeParseSpec({
        ...example,
        components: [
          {
            id: "root",
            type: "presentChart",
            props: {},
            data: { $ref: "query://ledger/sales_summary?fy=2026", rows: [{ x: 1 }] },
          },
        ],
        events: [],
      });
      return !bulkWithRef.ok || "bulk data (rows) mixed into data is not rejected";
    }),
  );

  results.push(
    check("SPEC-EVT-001", () => {
      const ghost = safeParseSpec({
        ...example,
        events: [{ on: "ghost.click", emit: "intent.patch", payload: {} }],
      });
      return !ghost.ok || "a non-existent event target is not rejected";
    }),
  );

  results.push(
    check("SPEC-PATCH-001", () => {
      const spec = parseSpec(example);
      const next: UISpec = {
        ...spec,
        components: spec.components.map((c) =>
          c.id === "title" ? { ...c, props: { ...c.props, text: "updated" } } : c,
        ),
      };
      const applied = applyPatch(spec, diffSpec(spec, next));
      // canonicalStringify (key-sorted) rather than JSON.stringify: applyPatch always constructs its
      // result with a fixed field order, which need not match a hand-spread expected object's insertion
      // order, so a raw JSON.stringify comparison is a false negative waiting to happen.
      if (canonicalStringify(applied) !== canonicalStringify(next)) {
        return "diff/apply round-trip does not hold";
      }

      // Cross-version case: a patch that also promotes kohaku 0.1 -> 0.2 while introducing `state` must
      // round-trip too (the version change itself is patch data, not just a byproduct of the target Spec).
      // Without carrying `kohaku` on the patch, applying against a 0.1 base would keep kohaku "0.1" while
      // adding `state`, which fails VERSION_FEATURE_MISMATCH instead of round-tripping.
      const spec01: UISpec = { ...spec, kohaku: "0.1" };
      const spec02WithState: UISpec = { ...spec, kohaku: "0.2", state: { tab: "a" } };
      const upgraded = applyPatch(spec01, diffSpec(spec01, spec02WithState));
      if (canonicalStringify(upgraded) !== canonicalStringify(spec02WithState)) {
        return "0.1 -> 0.2 round-trip (with state) does not hold";
      }
      const downgraded = applyPatch(spec02WithState, diffSpec(spec02WithState, spec01));
      return (
        canonicalStringify(downgraded) === canonicalStringify(spec01) || "0.2 -> 0.1 round-trip does not hold"
      );
    }),
  );

  results.push(
    check("SPEC-STA-001", () => {
      // Valid: 0.2 + initial state values + reference-consistent visibleWhen + key-consistent state.set.
      const ok = safeParseSpec({
        ...example,
        kohaku: "0.2",
        state: { tab: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["btn", "panel"] },
          { id: "btn", type: "presentMarkdown", props: {} },
          { id: "panel", type: "presentMarkdown", props: {}, visibleWhen: { ref: "$state.tab", eq: "a" } },
        ],
        events: [{ on: "btn.press", emit: "state.set", payload: { key: "tab", value: "a" } }],
      });
      // Feature gate: putting state on 0.1 yields VERSION_FEATURE_MISMATCH.
      const gated = safeParseSpec({
        ...example,
        kohaku: "0.1",
        state: { tab: "a" },
        components: [{ id: "root", type: "layout.stack", props: {} }],
        events: [],
      });
      // Reference consistency: a missing initial value for visibleWhen.ref is STATE_REF_UNKNOWN.
      const unknownRef = safeParseSpec({
        ...example,
        kohaku: "0.2",
        state: {},
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["p"] },
          { id: "p", type: "presentMarkdown", props: {}, visibleWhen: { ref: "$state.missing", eq: "a" } },
        ],
        events: [],
      });
      // Reference consistency: a missing target key for state.set is STATE_SET_INVALID.
      const badSet = safeParseSpec({
        ...example,
        kohaku: "0.2",
        state: { tab: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["btn"] },
          { id: "btn", type: "presentMarkdown", props: {} },
        ],
        events: [{ on: "btn.press", emit: "state.set", payload: { key: "nope", value: "x" } }],
      });
      // Compound predicate (all / any / not + numeric comparison): passes if every referenced key has an initial value.
      const compoundOk = safeParseSpec({
        ...example,
        kohaku: "0.2",
        state: { tab: "a", n: 0 },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["panel"] },
          {
            id: "panel",
            type: "presentMarkdown",
            props: {},
            visibleWhen: { all: [{ ref: "$state.tab", eq: "a" }, { not: { ref: "$state.n", gt: 10 } }] },
          },
        ],
        events: [],
      });
      // A nested leaf of a compound predicate referencing an undeclared key is STATE_REF_UNKNOWN.
      const compoundUnknown = safeParseSpec({
        ...example,
        kohaku: "0.2",
        state: { tab: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["panel"] },
          {
            id: "panel",
            type: "presentMarkdown",
            props: {},
            visibleWhen: {
              any: [
                { ref: "$state.tab", eq: "a" },
                { ref: "$state.missing", exists: true },
              ],
            },
          },
        ],
        events: [],
      });
      return (
        (ok.ok && !gated.ok && !unknownRef.ok && !badSet.ok && compoundOk.ok && !compoundUnknown.ok) ||
        "the state feature gate / reference consistency (including compound predicates) is not effective"
      );
    }),
  );

  results.push(
    check("SPEC-STA-002", () => {
      const REF = "query://sales/summary?fy=2026&region=japan";
      const kpi = (data: unknown) => ({
        ...example,
        kohaku: "0.2" as const,
        state: { region: "japan" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
          { id: "kpi", type: "presentMetric", props: {}, data },
        ],
        events: [],
      });
      // Valid: the three agree — initial variant ($ref's region=japan) = initial state = an element of values.
      const ok = safeParseSpec(
        kpi({ $ref: REF, bind: { region: { $state: "region", values: ["japan", "europe"] } } }),
      );
      // Feature gate: putting data.bind on 0.1 yields VERSION_FEATURE_MISMATCH.
      const gated = safeParseSpec({
        ...kpi({ $ref: REF, bind: { region: { $state: "region", values: ["japan"] } } }),
        kohaku: "0.1",
      });
      // BIND_STATE_UNKNOWN: the $state key's initial value is not in spec.state.
      const unknownState = safeParseSpec({
        ...kpi({ $ref: REF, bind: { region: { $state: "missing", values: ["japan"] } } }),
        state: {},
      });
      // BIND_VALUE_INVALID: $ref's region=japan is not in values (the initial variant must be an authorized value).
      const badValue = safeParseSpec(
        kpi({ $ref: REF, bind: { region: { $state: "region", values: ["europe"] } } }),
      );
      // BIND_PARAM_RESERVED: a bind parameter starts with _ (collides with the reserved namespace).
      const reserved = safeParseSpec(
        kpi({ $ref: REF, bind: { _region: { $state: "region", values: ["japan"] } } }),
      );
      return (
        (ok.ok && !gated.ok && !unknownState.ok && !badValue.ok && !reserved.ok) ||
        "the bind feature gate / initial-variant consistency is not effective"
      );
    }),
  );

  return results;
}

function check(id: string, fn: () => true | string): ConformanceResult {
  try {
    const result = fn();
    return result === true ? { id, pass: true } : { id, pass: false, detail: result };
  } catch (e) {
    return { id, pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkAsync(id: string, fn: () => Promise<true | string>): Promise<ConformanceResult> {
  try {
    const result = await fn();
    return result === true ? { id, pass: true } : { id, pass: false, detail: result };
  } catch (e) {
    return { id, pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
