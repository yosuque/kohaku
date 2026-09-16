/**
 * Generates the cross-language golden fixtures (the TS implementation is authoritative; the fixtures are derived).
 * Run: pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures
 *
 * Pins the byte representation of canonical JSON, sha256, intent hash, and spec/structure hash, and
 * checks that both the TS (spec/test/cross-language.test.ts) and Python (python/kohaku/tests/spec/
 * test_cross_language_golden.py) implementations reproduce the same fixture.
 * If either implementation changes and breaks byte compatibility, both sides' CI fail together.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportDistillationDataset } from "@kohaku-ui/evals";
import {
  ALLOWED_ATTRS,
  ALLOWED_STYLE_PROPS,
  ALLOWED_TAGS,
  type CacheKeyParts,
  cacheKey,
  canonicalStringify,
  computeIntentHash,
  computeSpecHash,
  computeStructureHash,
  type FixationRecord,
  type JsonObject,
  parseSpec,
  sha256Hex,
} from "@kohaku-ui/spec-core";
// Relative (not "@kohaku-ui/registry") import: the spec package deliberately does not declare
// @kohaku-ui/registry as a dependency (this generator is its only consumer of the catalog's
// fallback.mapProps functions), so this reaches the source file directly rather than adding a
// package.json dependency edge + pnpm-lock.yaml churn for a single script.
import { coreCatalog } from "../../packages/registry/src/core/index.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");
mkdirSync(OUT_DIR, { recursive: true });

// Corpus that pins byte compatibility of canonical JSON. Covers number formatting (ES Number::toString
// exponent switchover and shortest round-trip), key sorting (array-index keys first by ascending numeric
// value + UTF-16 code-unit order), and string escaping (control chars, lone surrogates, non-ASCII pass-through).
const CANONICAL_VALUES: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  9007199254740992, // 2^53
  0.1,
  -0.1,
  1.5,
  1e20,
  1e21, // boundary where exponential notation kicks in
  1.5e21,
  1e-6,
  1e-7, // boundary where exponential notation kicks in (lower side)
  5e-324, // smallest subnormal
  1.7976931348623157e308, // largest finite value
  123.456,
  0.001,
  1 / 3,
  0.30000000000000004,
  6.02e23,
  1e16,
  "",
  "abc",
  "日本語",
  "emoji 😀",
  'quote"back\\slash',
  "\b\t\n\f\r\u0000\u001f",
  "\ud800", // lone surrogate (high)
  "a\udfffb", // wraps a lone surrogate (low)
  [],
  [null, true, 1.5, "s", [1, 2], { b: 1, a: 2 }],
  {},
  // array-index keys ("2", "10") come first in ascending numeric order (ES OrdinaryOwnPropertyKeys)
  { b: 1, a: 2, "10": 3, "2": 4, "": 5, A: 6, _: 7, "😀": 8, "￿": 9 },
  { nested: { z: [1, { y: 2, x: 3 }], w: null } },
  {
    intentLike: {
      canonical: "sales.quarterly_summary",
      params: { fiscalYear: 2026, groupBy: "region", quarter: 3 },
    },
  },
];

// Pins the core catalog's fallback.mapProps functions across languages. The Python implementation
// cannot deserialize a function from core-catalog.json (export-core-catalog.ts's own docstring notes
// this), so it hand-ports each fallbackType's mapProps into a `_FALLBACK_MAP_PROPS` dict
// (python/kohaku/src/kohaku/registry/core/__init__.py) that a human keeps in sync with core/*.ts by
// eye. This fixture is the automated backstop for that hand-port: feed the same inputProps to the TS
// mapProps here and to Python's _FALLBACK_MAP_PROPS in test_fallback, and require byte-identical
// mappedProps. Several cases per dynamic type also pin the `??` (nullish, not falsy) coalescing
// semantics the Python side has to replicate by hand (see js_string / _nullish in that module) --
// an absent key and a present-but-omitted optional key must map to the same default.
const FALLBACK_CASES: { type: string; inputProps: JsonObject }[] = [
  { type: "action.button", inputProps: { label: "Approve", variant: "primary" } },
  { type: "action.button", inputProps: {} },
  { type: "presentForm", inputProps: { fields: [{ name: "a" }], action: "save" } },
  { type: "presentChart", inputProps: { kind: "bar", x: "region", y: "revenue" } },
  { type: "presentSpreadsheet", inputProps: { editable: false } },
  { type: "presentList", inputProps: { gap: "sm" } },
  { type: "presentMetric", inputProps: { label: "Revenue", valueColumn: "revenue" } },
  { type: "presentMetric", inputProps: { label: "", valueColumn: "revenue" } },
  { type: "control.select", inputProps: { options: ["a"], label: "Region" } },
  { type: "control.select", inputProps: { options: ["a"], value: "west" } },
  { type: "control.select", inputProps: { options: ["a"] } },
  { type: "ui.loading", inputProps: { label: "Fetching…" } },
  { type: "ui.loading", inputProps: {} },
  { type: "layout.tabs", inputProps: { stateKey: "tab" } },
  { type: "layout.tab", inputProps: { value: "a", label: "A" } },
  { type: "overlay.dialog", inputProps: { title: "Confirm" } },
  { type: "overlay.toast", inputProps: { message: "Saved" } },
  { type: "overlay.toast", inputProps: {} },
];

const INTENT_CASES: { canonical: string; params: Record<string, unknown> }[] = [
  { canonical: "sales.quarterly_summary", params: { fiscalYear: 2026, groupBy: "region", quarter: 3 } },
  { canonical: "sales.trend", params: {} },
  {
    canonical: "sales.custom",
    params: { request: "売上をカレンダーヒートマップで", flags: [true, null, 1.5] },
  },
  { canonical: "a.b_c", params: { z: { y: [1, 2, 3], x: "☃" }, ratio: 1 / 3 } },
];

// Pins spec-core's cacheKey() segment/placeholder format across languages (the policyFingerprint 7th
// component). Every legacy shape (5 / 6 components) plus the new 7-component shapes (policyFingerprint
// alone with its "-" generatorVersion placeholder, and both together) so a language port that gets the
// positional placeholder logic wrong fails this golden immediately.
const CACHE_KEY_CASES: CacheKeyParts[] = [
  { intentHash: "sha256:aaa", dataVersion: "v1" },
  { intentHash: "sha256:aaa", dataVersion: "v1", catalogFingerprint: "cat1" },
  { intentHash: "sha256:aaa", dataVersion: "v1", catalogFingerprint: "cat1", generatorVersion: "gv1" },
  { intentHash: "sha256:aaa", dataVersion: "v1", catalogFingerprint: "cat1", policyFingerprint: "pf1" },
  {
    intentHash: "sha256:aaa",
    dataVersion: "v1",
    catalogFingerprint: "cat1",
    generatorVersion: "gv1",
    policyFingerprint: "pf1",
  },
  { intentHash: "sha256:aaa", dataVersion: "v1", catalogFingerprint: "cat1", policyFingerprint: "" },
];

async function main(): Promise<void> {
  const canonical = CANONICAL_VALUES.map((value) => {
    const text = canonicalStringify(value);
    return { value, canonical: text };
  });
  // JSON containing lone surrogates round-trips through JSON.parse, but the fixture file itself is
  // kept well-formed (JSON.stringify escapes them, so it stays safe).
  const hashes = await Promise.all(canonical.map(async (c) => sha256Hex(c.canonical)));
  const canonicalCases = canonical.map((c, i) => ({ ...c, sha256: hashes[i] }));

  const intentCases = await Promise.all(
    INTENT_CASES.map(async (c) => ({
      ...c,
      hash: await computeIntentHash({ canonical: c.canonical, params: c.params as never }),
    })),
  );

  const fallbackCases = FALLBACK_CASES.map((c) => {
    const def = coreCatalog.components.find((d) => d.type === c.type);
    if (def?.fallback == null) {
      throw new Error(`FALLBACK_CASES references "${c.type}", which has no fallback in the core catalog`);
    }
    return { ...c, mappedProps: def.fallback.mapProps(c.inputProps) };
  });

  const exampleSpec = parseSpec(
    JSON.parse(readFileSync(join(OUT_DIR, "../../examples/quarterly-sales.spec.json"), "utf8")),
  );
  const spec = {
    file: "spec/examples/quarterly-sales.spec.json",
    specHash: await computeSpecHash(exampleSpec),
    structureHash: await computeStructureHash(exampleSpec),
  };

  const cacheKeyCases = CACHE_KEY_CASES.map((parts) => ({ parts, key: cacheKey(parts) }));

  // Pins byte compatibility of the distillation-dataset JSONL export (@kohaku-ui/evals's
  // exportDistillationDataset / kohaku.evals's export_distillation_dataset). Reuses the same example
  // Spec + its already-computed structureHash as a single human-approved FixationRecord, so a language
  // port that gets canonical-JSON key ordering, $ref extraction, or the {intent, refs, target, source,
  // meta} projection wrong fails this golden immediately.
  // Carries tenant + catalogFingerprint (meta.tenant / meta.catalogFingerprint) so a port that drops them,
  // or writes an absent one as null instead of omitting the key (a real cross-language pitfall: Python's
  // canonical_stringify writes None as JSON null rather than dropping it the way JS drops undefined), fails
  // this golden. The same example Spec is also passed as a `golden` entry sharing the fixation's
  // intentHash, so the fixture pins the fixation-before-golden tie-break for entries with an equal sort key.
  const distillationRecord: FixationRecord = {
    intentHash: exampleSpec.intent.hash,
    canonical: exampleSpec.intent.canonical,
    structureHash: spec.structureHash,
    pinnedSpec: exampleSpec,
    fixatedAt: "2026-06-10T03:12:00Z",
    approver: { id: "qa-lead" },
    tenant: "tenant-acme",
    catalogFingerprint: "catalog@2026-06-10",
  };
  const distillation = {
    jsonl: exportDistillationDataset({ fixations: [distillationRecord], golden: [exampleSpec] }),
  };

  // Pins that the sandbox DOM allowlist (packages/spec-core/src/schema/sandbox-dom.ts) has not drifted from
  // its Python mirror (python/kohaku/src/kohaku/spec/sandbox_dom.py). Sorted so the fixture diff is stable.
  const sandboxDom = {
    tags: [...ALLOWED_TAGS].sort(),
    attrs: [...ALLOWED_ATTRS].sort(),
    styleProps: [...ALLOWED_STYLE_PROPS].sort(),
  };

  writeFileSync(
    join(OUT_DIR, "cross-language-canonical.json"),
    JSON.stringify(
      {
        canonical: canonicalCases,
        intents: intentCases,
        spec,
        cacheKey: cacheKeyCases,
        sandboxDom,
        distillation,
        fallback: fallbackCases,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `generated: test/fixtures/cross-language-canonical.json (canonical=${canonicalCases.length}, intents=${intentCases.length}, cacheKey=${cacheKeyCases.length}, fallback=${fallbackCases.length})`,
  );
}

await main();
