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
  type ActionParamsSchema,
  ALLOWED_ATTRS,
  ALLOWED_STYLE_PROPS,
  ALLOWED_TAGS,
  actionPayloadHash,
  type CacheKeyParts,
  cacheKey,
  canonicalStringify,
  computeIntentHash,
  computeSpecHash,
  computeStructureHash,
  encodeSeqCursor,
  type FixationRecord,
  type JsonObject,
  type LineageEventRecord,
  type LineagePage,
  type LineagePageRequest,
  type PromotionState,
  pageLineageArray,
  parseSpec,
  sha256Hex,
  validateActionParams,
} from "@kohaku-ui/spec-core";
// Relative rather than "@kohaku-ui/composer", same reasoning as the registry import below: spec does
// not declare a dependency on composer either. design-system.ts is safe to reach this way because it
// imports nothing but spec-core *types* (see that file's own header comment: no @kohaku-ui/llm import at
// all). prompt.ts's own cross-package imports (registry / spec-core) are safe too, even though this
// script does not declare either as its own dependency: Node resolves a bare specifier starting from the
// *importing file's own directory* (packages/composer/src, whose node_modules holds composer's own
// dependencies via pnpm's symlinks), not from this script's location, so they resolve exactly as they do
// when composer's own tests import prompt.ts.
import {
  DEFAULT_KIT_VOCABULARY,
  type DesignSystemGuide,
  designKitPromptFragment,
  designSystemPromptFragment,
} from "../../packages/composer/src/design-system.js";
import { L2_SYSTEM_PROMPT, PROMPT_REVISION } from "../../packages/composer/src/prompt.js";
// Relative rather than "@kohaku-ui/lineage": spec does not declare a dependency on lineage either
// (same reasoning as the composer / registry imports below). Everything reached here (build.ts,
// sign.ts) imports nothing outside spec-core, which this script already depends on directly.
import {
  buildEvidencePack,
  deriveEd25519KeyId,
  type EvidenceSource,
  importEd25519PrivateKeyPkcs8,
  importEd25519PublicKeyRaw,
  signManifest,
  verifyManifestSignature,
} from "../../packages/lineage/src/index.js";
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

// Same representative DesignSystemGuide as packages/composer/test/design-system.test.ts's GUIDE
// (description override + a custom token + guidelines), so designSystemPromptFragment exercises every
// branch (default vocabulary, override, custom-token appending, rules section) that a byte-compatibility
// golden needs to catch a drift.
const DESIGN_SYSTEM_GUIDE: DesignSystemGuide = {
  tokens: { "color.primary": "brand color (override)", "brand.accent": "accent color" },
  guidelines: ["Corner radius is 8px", "Spacing in multiples of 4px"],
};

// Pins spec-core's cacheKey() segment/placeholder format across languages (the policyFingerprint 7th
// component). Every legacy shape (5 / 6 components) plus the new 7-component shapes (policyFingerprint
// alone with its "-" generatorVersion placeholder, and both together) so a language port that gets the
// positional placeholder logic wrong fails this golden immediately.
// Pins the opaque {v,seq} base64url lineage-paging cursor (design.md #53) byte-for-byte across languages:
// packages/spec-core/src/lineage-page.ts's encodeSeqCursor/decodeSeqCursor and their Python mirror
// (kohaku.spec.lineage_page). 0 / 1 are the boundary seqs a fresh page/cursor start from; 42 is an
// arbitrary mid-range value; 1234567890123 exceeds 2^32 (a value large enough that a naive 32-bit-int
// encoding on either side would truncate it) while staying within IEEE-754/Python-int exact range.
const LINEAGE_CURSOR_SEQS: number[] = [0, 1, 42, 1234567890123];

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

// Pins kohaku's action-params JSON Schema subset validator (design.md #62; spec-core's
// action-params.ts / schema/action-params.ts and their Python mirror spec/action_params.py) byte-for-byte
// across languages: the exact `issues[]` (`{ path, code, message }`) validateActionParams reports for a
// given (schema, payload) pair, and the `sha256:<hex>` actionPayloadHash binds an approval token to
// (design.md #63). Every root schema is `type: "object"` (the real shape of an action's params), so a
// single payloadHash can be computed per case alongside its issues. Covers: a fully valid payload;
// `required` / `additionalProperties: false` violations; `minLength`/`maxLength` on a nested string;
// `minimum`/`maximum` and integer-vs-number on a nested number; `enum`; array `items` + `maxItems` with
// the `parent[i]` index-path convention; a nested object's dot-separated path; and an `x-message`
// override replacing the default wording.
const ACTION_PARAMS_CASES: { schema: ActionParamsSchema; payload: JsonObject }[] = [
  {
    schema: {
      type: "object",
      properties: { note: { type: "string", maxLength: 500 } },
      required: ["note"],
      additionalProperties: false,
    },
    payload: { note: "Looks good to me." },
  },
  {
    schema: {
      type: "object",
      properties: { note: { type: "string", maxLength: 500 } },
      required: ["note"],
      additionalProperties: false,
    },
    payload: {},
  },
  {
    schema: {
      type: "object",
      properties: { note: { type: "string" } },
      additionalProperties: false,
    },
    payload: { note: "ok", extra: 1 },
  },
  {
    schema: { type: "object", properties: { s: { type: "string", minLength: 2, maxLength: 4 } } },
    payload: { s: "a" },
  },
  {
    schema: { type: "object", properties: { s: { type: "string", minLength: 2, maxLength: 4 } } },
    payload: { s: "abcde" },
  },
  {
    schema: { type: "object", properties: { n: { type: "integer", minimum: 0, maximum: 10 } } },
    payload: { n: -1 },
  },
  {
    schema: { type: "object", properties: { n: { type: "integer", minimum: 0, maximum: 10 } } },
    payload: { n: 1.5 },
  },
  {
    schema: { type: "object", properties: { severity: { type: "string", enum: ["low", "high"] } } },
    payload: { severity: "medium" },
  },
  {
    schema: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string", maxLength: 3 }, maxItems: 2 } },
    },
    payload: { tags: ["ok", "toolong", "x"] },
  },
  {
    schema: {
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: { city: { type: "string", minLength: 1 } },
          required: ["city"],
        },
      },
    },
    payload: { address: { city: "" } },
  },
  {
    schema: {
      type: "object",
      properties: { note: { type: "string", maxLength: 3, "x-message": "note is too long" } },
    },
    payload: { note: "abcd" },
  },
  // Prototype-pollution-shaped keys (the review finding this golden section was extended for): a plain
  // object literal with a `__proto__:` key sets the prototype rather than creating an own property (a
  // JS-source-only quirk), so this is built via JSON.parse to match the own-property shape a real
  // request body actually has once parsed off the wire -- the same shape both languages' hosts see.
  {
    schema: { type: "object", properties: { amount: { type: "number" } } },
    payload: JSON.parse('{"amount":10,"__proto__":{"polluted":true}}') as JsonObject,
  },
  {
    schema: { type: "object", properties: { amount: { type: "number" } } },
    payload: JSON.parse('{"amount":10,"constructor":{"polluted":true}}') as JsonObject,
  },
  // "toString" is not in the hard-rejected set (unlike __proto__/constructor/prototype above), but
  // without Object.hasOwn-based property lookup it would previously resolve `properties["toString"]` to
  // the inherited Object.prototype.toString function instead of undefined, silently skipping both the
  // additionalProperties check below and real validation. This pins that it now correctly reports
  // additionalProperties, the same as any other undeclared key would.
  {
    schema: {
      type: "object",
      properties: { amount: { type: "number" } },
      additionalProperties: false,
    },
    payload: JSON.parse('{"amount":10,"toString":1}') as JsonObject,
  },
];

// Pins the Compliance Evidence Pack (design.md #67) byte-for-byte across languages: canonical-JSON
// serialization of events.jsonl/approvals.jsonl/promotions.jsonl/fixations.jsonl, artifact extraction
// and hash-mismatch warning wording, manifest assembly, and the Ed25519 signature itself (deterministic,
// so a matching keypair + message always produces the identical signature in any correct
// implementation). Signed with RFC 8032 Section 7.1 TEST 1's keypair -- the same well-known, publicly
// verifiable vector packages/lineage/test/evidence-sign.test.ts and
// python/kohaku/tests/lineage/test_evidence.py independently pin -- rather than a fixture-specific
// secret, so nothing sensitive is committed and the vector's provenance is checkable by anyone.
const EVIDENCE_ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";
const EVIDENCE_RFC8032_TEST1_SECRET_KEY_SEED =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const EVIDENCE_RFC8032_TEST1_PUBLIC_KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const EVIDENCE_TENANT = "tenant-acme";
const EVIDENCE_SCOPE = {
  tenant: EVIDENCE_TENANT,
  since: "2026-06-01T00:00:00.000Z",
  until: "2026-06-30T23:59:59.999Z",
};
const EVIDENCE_GENERATOR = "kohaku-evidence-fixture/1";
const EVIDENCE_GENERATED_AT = "2026-06-15T00:00:00.000Z";
const EVIDENCE_ARTIFACT_A_HTML = "<div>Q3 Sales Summary</div>";
const EVIDENCE_ARTIFACT_B_HTML = "<div>Regional Breakdown</div>";
// Deliberately wrong (pins the exact warning-message wording across languages -- see build.ts's
// `warnings.push` / evidence.py's matching f-string; a fixture whose html hash happened to be correct
// everywhere would never exercise that code path at all).
const EVIDENCE_WRONG_ARTIFACT_A_SHA256 = "0".repeat(64);

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

  const lineageCursorCases = LINEAGE_CURSOR_SEQS.map((seq) => ({ seq, cursor: encodeSeqCursor(seq) }));

  const actionParamsCases = await Promise.all(
    ACTION_PARAMS_CASES.map(async ({ schema, payload }) => ({
      schema,
      payload,
      issues: validateActionParams(schema, payload),
      payloadHash: await actionPayloadHash(payload),
    })),
  );

  // Pins the prompt fragments that are hand-transcribed as goldens in both languages' composer tests
  // (packages/composer/test/design-kit.test.ts + design-system.test.ts and their Python mirrors under
  // python/kohaku/tests/composer/), replacing each side's own independent hand-written literal with a
  // single, TS-generated source of truth. Before this, each language's test only checked its own
  // constants against its own hand-copied string, so a matching pair of (constant, golden) edits on one
  // language side alone passed CI while silently diverging from the other language.
  // designKit needs no separate input in the fixture: both languages already own an identical exported
  // DEFAULT_KIT_VOCABULARY constant (itself pinned by this same golden — a divergent constant changes
  // the rendered fragment), so each side's test re-applies its own function to its own constant.
  // designSystem's DESIGN_SYSTEM_GUIDE, by contrast, is not an exported constant on either side (it is a
  // local test fixture), so its input is carried in the fixture itself for the other language to
  // reconstruct exactly, rather than hand-duplicating the same object literal a third time.
  const l2Lines = L2_SYSTEM_PROMPT.split("\n");
  const designBriefMarker = "- Design brief (follow every point):";
  const designBriefStart = l2Lines.indexOf(designBriefMarker);
  if (designBriefStart === -1) {
    throw new Error(
      `L2_SYSTEM_PROMPT no longer contains the design-brief marker ${JSON.stringify(designBriefMarker)}`,
    );
  }
  // The design brief is L2_SYSTEM_PROMPT's trailing block (its header line through the prompt's last
  // line) -- pinned by content rather than a hardcoded line count so this keeps working if it grows.
  const designBrief = l2Lines.slice(designBriefStart);

  const promptFragments = {
    designKit: designKitPromptFragment(DEFAULT_KIT_VOCABULARY),
    designSystem: {
      guide: DESIGN_SYSTEM_GUIDE,
      fragment: designSystemPromptFragment(DESIGN_SYSTEM_GUIDE),
    },
    designBrief,
    promptRevision: PROMPT_REVISION,
  };

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

  // Compliance Evidence Pack golden (design.md #67; see the EVIDENCE_* constants' comments above).
  // Reuses distillationRecord (above) as the pack's one fixation, so the fixture does not carry a
  // second full UISpec merely to have "a" fixation.
  const evidenceEvents: LineageEventRecord[] = [
    {
      id: "eev-1",
      ts: "2026-06-01T00:00:00.000Z",
      actor: { kind: "system" },
      type: "view.composed",
      payload: { tier: "L1", cache: "miss" },
      tenant: EVIDENCE_TENANT,
    },
    {
      id: "eev-2",
      ts: "2026-06-02T00:00:00.000Z",
      actor: { kind: "model", model: "test-model" },
      type: "component.generated",
      payload: {
        artifactId: "artifact-a",
        artifactSha256: EVIDENCE_WRONG_ARTIFACT_A_SHA256,
        html: EVIDENCE_ARTIFACT_A_HTML,
      },
      tenant: EVIDENCE_TENANT,
    },
    {
      id: "eev-3",
      ts: "2026-06-03T00:00:00.000Z",
      actor: { kind: "user", id: "reviewer-1" },
      type: "component.reviewed",
      payload: { artifactId: "artifact-a", decision: "approve" },
      tenant: EVIDENCE_TENANT,
    },
    {
      id: "eev-4",
      ts: "2026-06-04T00:00:00.000Z",
      actor: { kind: "system" },
      type: "intent.fixated",
      payload: { intentHash: exampleSpec.intent.hash },
      tenant: EVIDENCE_TENANT,
    },
    {
      id: "eev-5",
      ts: "2026-06-05T00:00:00.000Z",
      actor: { kind: "user", id: "reviewer-1" },
      type: "intent.unfixated",
      payload: { intentHash: `sha256:${"9".repeat(64)}` },
      tenant: EVIDENCE_TENANT,
    },
  ];
  const evidenceArtifactBSha256 = await sha256Hex(EVIDENCE_ARTIFACT_B_HTML);
  const evidencePromotions: PromotionState[] = [
    {
      artifactId: "artifact-b",
      status: "published",
      updatedAt: "2026-06-06T00:00:00.000Z",
      data: { html: EVIDENCE_ARTIFACT_B_HTML, sha256: evidenceArtifactBSha256 },
      tenant: EVIDENCE_TENANT,
    },
  ];
  const evidenceFixations: FixationRecord[] = [distillationRecord];

  const evidenceSource: EvidenceSource = {
    async listLineage(filter) {
      // Never actually exercised (pageLineage below is always present, so buildEvidencePack prefers
      // it), but implemented for real rather than stubbed so this object stays an honest EvidenceSource.
      return evidenceEvents.filter((e) => {
        if (filter.tenant != null && e.tenant !== filter.tenant) return false;
        if (filter.since != null && e.ts < filter.since) return false;
        if (filter.until != null && e.ts > filter.until) return false;
        return true;
      });
    },
    async pageLineage(req: LineagePageRequest): Promise<LineagePage> {
      return pageLineageArray(evidenceEvents, req);
    },
    async listPromotionStates(tenant) {
      return tenant == null ? evidencePromotions : evidencePromotions.filter((p) => p.tenant === tenant);
    },
    async listFixations(tenant) {
      return tenant == null ? evidenceFixations : evidenceFixations.filter((f) => f.tenant === tenant);
    },
  };

  const evidencePrivateKey = await importEd25519PrivateKeyPkcs8(
    hexToBytes(EVIDENCE_ED25519_PKCS8_PREFIX + EVIDENCE_RFC8032_TEST1_SECRET_KEY_SEED),
  );
  const evidencePublicKeyRaw = hexToBytes(EVIDENCE_RFC8032_TEST1_PUBLIC_KEY);
  const evidenceKeyId = await deriveEd25519KeyId(evidencePublicKeyRaw);

  const builtEvidencePack = await buildEvidencePack({
    source: evidenceSource,
    scope: EVIDENCE_SCOPE,
    generator: EVIDENCE_GENERATOR,
    signer: { alg: "Ed25519", keyId: evidenceKeyId },
    now: () => new Date(EVIDENCE_GENERATED_AT),
  });
  const evidenceSignature = await signManifest(builtEvidencePack.manifest, evidencePrivateKey);

  // Self-check before writing: a regression in signManifest/verifyManifestSignature must not silently
  // produce a fixture the golden tests would then both (wrongly) agree on.
  const evidencePublicKey = await importEd25519PublicKeyRaw(evidencePublicKeyRaw);
  if (!(await verifyManifestSignature(builtEvidencePack.manifest, evidenceSignature, evidencePublicKey))) {
    throw new Error(
      "generate-cross-language-fixtures: evidence pack self-check failed (signature does not verify)",
    );
  }

  const evidencePackStore = {
    scope: EVIDENCE_SCOPE,
    generator: EVIDENCE_GENERATOR,
    generatedAt: EVIDENCE_GENERATED_AT,
    events: evidenceEvents,
    promotions: evidencePromotions,
    fixations: evidenceFixations,
  };
  const evidencePackDir = join(OUT_DIR, "evidence-pack");
  mkdirSync(evidencePackDir, { recursive: true });
  writeFileSync(join(evidencePackDir, "store.json"), `${JSON.stringify(evidencePackStore, null, 2)}\n`);
  writeFileSync(
    join(evidencePackDir, "manifest.json"),
    `${JSON.stringify(builtEvidencePack.manifest, null, 2)}\n`,
  );
  writeFileSync(join(evidencePackDir, "manifest.sig"), `${evidenceSignature}\n`);

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
        lineageCursor: lineageCursorCases,
        actionParams: actionParamsCases,
        sandboxDom,
        distillation,
        fallback: fallbackCases,
        promptFragments,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `generated: test/fixtures/cross-language-canonical.json (canonical=${canonicalCases.length}, intents=${intentCases.length}, cacheKey=${cacheKeyCases.length}, lineageCursor=${lineageCursorCases.length}, actionParams=${actionParamsCases.length}, fallback=${fallbackCases.length}, promptRevision=${PROMPT_REVISION})`,
  );
  console.log(
    `generated: test/fixtures/evidence-pack/{store.json,manifest.json,manifest.sig} (events=${evidenceEvents.length}, promotions=${evidencePromotions.length}, fixations=${evidenceFixations.length}, artifacts=${builtEvidencePack.manifest.counts.artifacts}, warnings=${builtEvidencePack.manifest.warnings.length})`,
  );
}

await main();
