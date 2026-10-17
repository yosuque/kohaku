import type { LlmPort } from "@kohaku-ui/llm";
import { canonicalStringify, sha256Hex } from "@kohaku-ui/spec-core";
import type { ComposeContext, ComposePolicy } from "./context.js";

// The policy-fingerprint machinery (the ComposePolicy fields that change prompt content, folded into the
// cache key's 7th component) lives here; context.ts keeps the policy/context types and entry resolution.
// The imports from ./context.js above are type-only, so there is no runtime cycle.

/** The extra `policyFingerprint` material contributed by `ComposeContext.llmByTier` — see `tierLlmFingerprintMaterial`. */
export interface TierLlmFingerprintMaterial {
  l1?: { provider: string; modelId: string };
  l2?: { provider: string; modelId: string };
}

/**
 * Computes the extra `policyFingerprint` material for `ctx.llmByTier` (see that field's own doc on
 * `ComposeContext`). Returns undefined — meaning "contribute nothing, cacheKey unaffected" — whenever
 * `llmByTier` is unset, or whenever every tier it does set resolves to the same `provider`/`modelId` as the
 * base `ctx.llm` (no actual generation difference to separate the cache for). Only when at least one set
 * tier's model genuinely differs from the base does this return the `{provider, modelId}` pairs for the
 * tiers `llmByTier` sets (a tier `llmByTier` never touched contributes nothing of its own — it already
 * generates with the same `ctx.llm` the rest of the cache key's generatorVersion/fingerprint story covers).
 */
export function tierLlmFingerprintMaterial(ctx: ComposeContext): TierLlmFingerprintMaterial | undefined {
  if (ctx.llmByTier == null) return undefined;
  const base = { provider: ctx.llm.provider, modelId: ctx.llm.modelId };
  const differsFromBase = (llm: LlmPort | undefined): boolean =>
    llm != null && (llm.provider !== base.provider || llm.modelId !== base.modelId);
  if (!differsFromBase(ctx.llmByTier.L1) && !differsFromBase(ctx.llmByTier.L2)) return undefined;
  const material: TierLlmFingerprintMaterial = {};
  if (ctx.llmByTier.L1 != null) {
    material.l1 = { provider: ctx.llmByTier.L1.provider, modelId: ctx.llmByTier.L1.modelId };
  }
  if (ctx.llmByTier.L2 != null) {
    material.l2 = { provider: ctx.llmByTier.L2.provider, modelId: ctx.llmByTier.L2.modelId };
  }
  return material;
}

/**
 * A canonical fingerprint (16 hex characters) of the ComposePolicy fields that change prompt content but
 * were, until now, only enforced by the operational convention of bumping `generatorVersion` by hand
 * (outputLanguage / designSystem / fewShot's supply source / selectComponents' narrowing function) — see
 * each field's own doc comment on ComposePolicy (context.ts). prepareCompose (compose.ts) feeds the result into
 * spec-core's `cacheKey` as the 7th component, so a policy shape that actually varies one of these fields
 * separates the cache automatically, without relying on every caller remembering the manual bump.
 *
 * **Returns the empty string when none of the five fields are set to a non-default value** (`policy` is
 * the "classic" shape with no fingerprinted field at all) — spec-core's `cacheKey` treats an empty
 * policyFingerprint exactly like an omitted one, so a policy that never touches these fields produces a
 * cache key byte-identical to before this function existed (no existing cache entry is invalidated by
 * introducing it).
 *
 * fewShot / selectComponents are functions (their actual behavior cannot be inspected), so only their
 * optional `id` participates (default `"anonymous"` when unset — not required, so existing callers that
 * never set `id` see no change in the fingerprint they already had). designSystem folds in a fixed pick of
 * fields — `tokens`, `guidelines`, `enforceTokenColors` — plus two design-kit fields:
 * `kit` folds in the whole object whenever set (a different `id`, `version`, `classes`, `utilities`,
 * `namespaces` or `skeleton` all separate the cache, matching `designKitPromptFragment`'s effect on the L2
 * prompt), and `enforceKitClasses` folds in **only when explicitly `false`** — the same non-default-only
 * pattern as `refConstraint` below, because both `true` and unset mean "the lint runs" and must stay
 * indistinguishable so a kit-less or already-linted cache key is untouched by this addition.
 * **A field folded in "only when non-default" must be written as an ABSENT key (`?? undefined`), never
 * as an explicit `null`**: `canonicalStringify`'s `sortDeep` (spec-core/canonical-json.ts) drops
 * `undefined` entries but keeps `null` ones, so a `null` default would still change the hashed bytes —
 * and therefore the cache key — for every policy that never touches that field. `refConstraint` below
 * folds to `null` in its default case only because that key has been part of this material's byte
 * layout since this function was introduced; a newly added key does not have that grandfathering and
 * must use `undefined` to stay truly additive.
 *
 * `refConstraint` participates **only when set to `"validate"`** — its default `"schema"` (whether set
 * explicitly or left unset) folds in as `null`, identically to being unset, so introducing this field
 * does not perturb the fingerprint (and therefore the cacheKey / any existing fixation-stability golden)
 * for every caller that has not opted into `"validate"`.
 *
 * `policy.effort` participates in full (both `l1`/`l2`, defaulted to `null` when only one is set)
 * whenever the object is set at all — effort changes generated output for the same Intent/model, so any
 * caller that wires it (even to `{}` with neither tier set — an edge case, but still a distinct policy
 * shape from never wiring the field) gets a separated cache key. Never set is indistinguishable from unset.
 *
 * The optional second argument `tierLlm` (compose.ts computes it via `tierLlmFingerprintMaterial(ctx)`
 * — see that function's own doc) folds in the identity of the models actually used per tier when
 * `ComposeContext.llmByTier` is wired to something that actually differs from the base `ctx.llm`. Passed
 * as `undefined` — its default — whenever `llmByTier` is unset or matches the base model everywhere, so a
 * caller that never touches `llmByTier` sees no change here either.
 *
 * **Which keys fold to `null` vs. an absent key, and why the material below looks inconsistent.** Ten of
 * the keys this function emits — `outputLanguage`, `designSystem` itself, `designSystem.tokens`,
 * `designSystem.guidelines`, `designSystem.enforceTokenColors`, `fewShotId`, `selectComponentsId`,
 * `refConstraint`, `effort`, `tierLlm` — fold to an explicit `null` in their default case. That is safe
 * *only* because all ten have been part of this material's hashed byte layout since the day each field
 * was added: every caller that has ever computed a fingerprint already has those `null` bytes baked into
 * its current cache key, so leaving them `null` changes nothing further. **It is not the pattern to copy**
 * — `fingerprintDesignSystem` below appears to write `?? null` ten times over, but that is historical
 * grandfathering, not a model for a new field. `designSystem.kit` / `designSystem.enforceKitClasses`
 * and the top-level `tierGate` row (`fingerprintTierGate`, Policy as Code) show the correct
 * shape for a field added *after* callers already depend on this material's bytes: fold to `undefined`
 * (an absent key), never `null` — see the ABSENT-key paragraph on their own extractor below.
 * **Any new fingerprinted field must follow `kit`/`enforceKitClasses`/`tierGate`, not the other
 * ten** (`canonicalStringify`'s `sortDeep` drops `undefined` but keeps `null` — see spec-core/canonical-json.ts).
 */
type PolicyFingerprintExtractor = (
  policy: ComposePolicy,
  tierLlm: TierLlmFingerprintMaterial | undefined,
) => unknown;

function fingerprintOutputLanguage(policy: ComposePolicy): unknown {
  return policy.outputLanguage ?? null;
}

function fingerprintDesignSystem(policy: ComposePolicy): unknown {
  const { designSystem } = policy;
  if (designSystem == null) return null;
  return {
    tokens: designSystem.tokens ?? null,
    guidelines: designSystem.guidelines ?? null,
    enforceTokenColors: designSystem.enforceTokenColors ?? null,
    // Folded in only when non-default, and as an ABSENT key (undefined) rather than an
    // explicit null: canonicalStringify's sortDeep drops undefined entries but KEEPS null
    // ones (packages/spec-core/src/canonical-json.ts), so writing `?? null` here would add
    // "kit":null / "enforceKitClasses":null to the hashed bytes of every existing
    // designSystem-bearing policy that never touches either field, silently invalidating
    // its compose cache. `undefined` is the only value that reproduces the pre-existing
    // byte layout exactly. This is the shape a newly added key must use — see
    // policyFingerprint's own doc comment above for why the three keys above it get away
    // with `null` instead.
    //
    // `kit.classes` is folded in as-is below. `designKitPromptFragment` presents classes **sorted by
    // name**, so the L2 prompt is a pure function of `kit.classes`' *content*, not its insertion order,
    // and canonicalStringify's sortDeep (packages/spec-core/src/canonical-json.ts) sorts object keys
    // before hashing — so two kits differing only in the insertion order of classes hash identically
    // (pinned by the "two kits differing only in the insertion order of `classes`" test in
    // policy-fingerprint.test.ts).
    kit: designSystem.kit != null ? { ...designSystem.kit } : undefined,
    enforceKitClasses: designSystem.enforceKitClasses === false ? false : undefined,
  };
}

/**
 * Whether `allowL2`/`routeTier` (the "tier gate") diverge from their conventional defaults
 * (`allowL2` unset/false, `routeTier` unset) — closes SPEC CMP-DET-002's cache-isolation gap: neither
 * field was part of `policyFingerprint` before this row existed, so two sessions differing only in
 * `allowL2` could otherwise share a cache entry produced under the more permissive one (a tenant with
 * `allowL2:false` receiving an L2 Spec that another tenant's `allowL2:true` session actually
 * generated) — see `tenant-cache-isolation.test.ts`.
 *
 * **Folded in as an ABSENT key (`undefined`), not `null`, whenever `allowL2` is not `true` and
 * `routeTier` is unset** — the overwhelming majority of existing policies touch neither field, and
 * this row is new (added after callers already depend on `policyFingerprint`'s current bytes), so
 * unlike the ten grandfathered `null`-default keys above it (see this file's `policyFingerprint` doc
 * comment), it must reproduce the pre-existing byte layout exactly for every such policy — returning
 * `null` here would add `"tierGate":null` to every existing fingerprint and silently invalidate every
 * existing compose cache the first time this ships.
 *
 * Once the row does activate (`allowL2 === true` or `routeTier` set), the material records **whether**
 * L2 is reachable and, when a `routeTier` function is supplied, **which** one — via its optional `id`
 * (`fewShot.id`/`selectComponents.id`'s convention: `"anonymous"` when the function carries no `id`)
 * — not the function's actual per-intent routing decisions, which are unobservable here (same
 * reasoning as `fingerprintSelectComponentsId`).
 */
function fingerprintTierGate(policy: ComposePolicy): unknown {
  const allowL2 = policy.allowL2 === true;
  const { routeTier } = policy;
  if (!allowL2 && routeTier == null) return undefined;
  return { allowL2, routeTierId: routeTier != null ? (routeTier.id ?? "anonymous") : null };
}

function fingerprintFewShotId(policy: ComposePolicy): unknown {
  const { fewShot } = policy;
  return fewShot != null ? (fewShot.id ?? "anonymous") : null;
}

function fingerprintSelectComponentsId(policy: ComposePolicy): unknown {
  const { selectComponents } = policy;
  return selectComponents != null ? (selectComponents.id ?? "anonymous") : null;
}

function fingerprintRefConstraint(policy: ComposePolicy): unknown {
  return policy.refConstraint === "validate" ? "validate" : null;
}

function fingerprintEffort(policy: ComposePolicy): unknown {
  const { effort } = policy;
  return effort != null ? { l1: effort.l1 ?? null, l2: effort.l2 ?? null } : null;
}

function fingerprintTierLlm(
  _policy: ComposePolicy,
  tierLlm: TierLlmFingerprintMaterial | undefined,
): unknown {
  return tierLlm ?? null;
}

/**
 * Ordered table of (material key, extractor) driving policyFingerprint() — mirrors Python's
 * `_FINGERPRINTED` (python/kohaku/src/kohaku/composer/context.py). One row per ComposePolicy field
 * that changes prompt content but was, until now, only enforced by the operational convention of
 * bumping `generatorVersion` by hand. Each extractor returns `null` when its field contributes
 * nothing (unset / default) — see `policyFingerprint`'s own doc comment above for which fields do
 * that via `?? null` (grandfathered into the byte layout) vs. via `?? undefined` (newly additive,
 * inside `fingerprintDesignSystem`'s returned object only) — and every row's key is always emitted
 * into `material`, including a `null` value, so the shape of the fingerprinted JSON is stable
 * regardless of which fields are set. Add a new row here (and a new extractor above) to fingerprint
 * another field; do not hand-sync a guard condition and an object literal separately.
 */
// Exported (but not re-exported from index.ts's public barrel) so the characterization test can
// assert the material key set directly — see the "detects an added/removed key" test in
// packages/composer/test/policy-fingerprint.test.ts, which fails if a key is added or removed here
// without the test being updated in the same change (the same purpose as Python's test reaching
// into `_FINGERPRINTED`).
export const FINGERPRINTED: ReadonlyArray<readonly [string, PolicyFingerprintExtractor]> = [
  ["outputLanguage", fingerprintOutputLanguage],
  ["designSystem", fingerprintDesignSystem],
  ["fewShotId", fingerprintFewShotId],
  ["selectComponentsId", fingerprintSelectComponentsId],
  ["refConstraint", fingerprintRefConstraint],
  ["effort", fingerprintEffort],
  ["tierLlm", fingerprintTierLlm],
  ["tierGate", fingerprintTierGate],
];

export async function policyFingerprint(
  policy: ComposePolicy,
  tierLlm?: TierLlmFingerprintMaterial,
): Promise<string> {
  const material: Record<string, unknown> = {};
  for (const [key, extract] of FINGERPRINTED) {
    material[key] = extract(policy, tierLlm);
  }
  if (Object.values(material).every((value) => value == null)) {
    return "";
  }
  const hex = await sha256Hex(canonicalStringify(material));
  return hex.slice(0, 16);
}
