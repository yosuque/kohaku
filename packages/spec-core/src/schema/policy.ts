import { z } from "zod";
import { canonicalStringify, sha256Hex } from "../canonical-json.js";

/**
 * Declarative policy file (Policy as Code, design.md #69): a JSON document that layers tenant
 * overrides on top of a default `ComposePolicy`/rate-limit/RBAC shape, so a governance operator can
 * change per-tenant behavior (L2 on/off, budgets, RBAC roles) without a code change or redeploy.
 *
 * **Scope boundary (design.md #69)**: only the *data* half of policy lives here. A field of
 * `ComposePolicy` that is itself a function (`routeTier`, `fewShot`, `designSystem`, `fixedSpecs`,
 * `l2Smoke`, `selectComponents`, `extraRules`) cannot be expressed in JSON and stays product code,
 * supplied as the base `ComposePolicy` the runtime layers this file's `compose` section onto (see
 * host-core's `createPolicyRuntime`). This schema intentionally has no field for any of them.
 *
 * Every object in this tree is `strictObject` (unknown keys rejected): a policy file is
 * operator-authored and hand-edited, so a typo'd key should fail loudly at load time rather than be
 * silently ignored.
 */

/**
 * Adaptive-Reasoning effort levels — duplicated from `@kohaku-ui/llm`'s `LlmEffort` as a plain literal
 * union rather than imported. spec-core sits at the base of the dependency direction (AGENTS.md's
 * "Dependency direction") and must not depend on `llm`, an independent leaf consumed only by
 * `composer`/`evals`. Keep this list in sync with `packages/llm/src/port.ts`'s `LlmEffort` by hand.
 */
const PolicyEffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

const PolicyEffortSchema = z.strictObject({
  l1: PolicyEffortLevelSchema.optional(),
  l2: PolicyEffortLevelSchema.optional(),
});

const PolicyBudgetSchema = z.strictObject({
  /** Mirrors `ComposeBudget.perCompose` (composer's context.ts). */
  perCompose: z.strictObject({ stopAfterTokens: z.number().int().nonnegative() }).optional(),
  /** Mirrors `ComposeBudget.deadlineMs`. */
  deadlineMs: z.number().int().positive().optional(),
  /**
   * A calendar-day (UTC) cumulative token budget. `ComposeBudget` itself has no notion of a day
   * boundary or persisted usage; the policy runtime (host-core's `createPolicyRuntime`, using the
   * daily-token ledger) wires this value into a `check`/`onUsage` pair that enforces it, rather than
   * this schema or `ComposeBudget` knowing about calendar days directly.
   *
   * **Soft limit under concurrency (design.md #69)**: `check` reads the ledger's current total and
   * `onUsage` records into it only after a compose completes, with no reservation step in between --
   * `ComposeBudget.check` must stay synchronous and side-effect-free, so it cannot reserve a slice of
   * the budget on the caller's behalf. N composes in flight at once for the same tenant can therefore
   * all observe the same pre-usage total and all pass `check`, before any of them calls `onUsage` --
   * the day's total can overshoot `dailyTokens` by at most `(concurrent in-flight generations) x (the
   * per-compose token ceiling)`. Set `perCompose.stopAfterTokens` to bound that ceiling (and so the
   * worst-case overshoot) if the effective daily cap needs to be tighter under load.
   */
  dailyTokens: z.number().int().nonnegative().optional(),
});

const PolicyComposeSchema = z.strictObject({
  /** Mirrors `ComposePolicy.allowL2`. */
  allowL2: z.boolean().optional(),
  /** Mirrors `ComposePolicy.maxRepairAttempts`. */
  maxRepairAttempts: z.number().int().nonnegative().optional(),
  /** Mirrors `ComposePolicy.refConstraint`. */
  refConstraint: z.enum(["schema", "validate"]).optional(),
  /** Mirrors `ComposePolicy.effort`. */
  effort: PolicyEffortSchema.optional(),
  /** Mirrors `ComposePolicy.outputLanguage`. */
  outputLanguage: z.string().optional(),
  /** Mirrors `ComposePolicy.cacheFailure`. */
  cacheFailure: z.enum(["open", "closed"]).optional(),
  /** Mirrors `ComposePolicy.ttlSeconds`. */
  ttlSeconds: z.number().int().nonnegative().optional(),
  budget: PolicyBudgetSchema.optional(),
});

/** A token-bucket rule: `capacity` tokens, refilled at `refillPerSecond` (see host-core's `RateLimitStore`). */
const PolicyRateLimitRuleSchema = z.strictObject({
  capacity: z.number().int().positive(),
  refillPerSecond: z.number().positive(),
});

const PolicyRateLimitsSchema = z.strictObject({
  compose: PolicyRateLimitRuleSchema.optional(),
  action: PolicyRateLimitRuleSchema.optional(),
  resolve: PolicyRateLimitRuleSchema.optional(),
});

/**
 * Mirrors host-rest's `GovernancePolicy.roles` (a role name -> allowed-pattern-list matrix). Patterns
 * stay plain strings at the schema level (not the `GovernancePattern` literal union): that union is
 * derived from host-rest's own `GovernanceOperationKind`, which spec-core must not depend on
 * (dependency direction) — the policy runtime hands these strings to `createGovernancePolicy` as-is,
 * which already treats an unrecognized pattern as a non-match (deny-by-default) at evaluation time.
 */
const PolicyGovernanceSchema = z.strictObject({
  roles: z.record(z.string(), z.array(z.string())),
});

const PolicySectionSchema = z.strictObject({
  compose: PolicyComposeSchema.optional(),
  rateLimits: PolicyRateLimitsSchema.optional(),
  governance: PolicyGovernanceSchema.optional(),
});

/** One `defaults` or `tenants[tenantId]` section of a policy file. */
export type PolicySection = z.infer<typeof PolicySectionSchema>;

/** The current (only) policy-file format version. */
export const KOHAKU_POLICY_FILE_VERSION = 1;

export const KohakuPolicyFileSchema = z.strictObject({
  /** Optional JSON-Schema pointer for editor completion (e.g. `"../../spec/schemas/policy.schema.json"`). Not interpreted by the loader. */
  $schema: z.string().optional(),
  version: z.literal(KOHAKU_POLICY_FILE_VERSION),
  /** A human-readable label surfaced in the `policy.applied` audit event (lineage). */
  label: z.string().optional(),
  defaults: PolicySectionSchema,
  tenants: z.record(z.string(), PolicySectionSchema).optional(),
});

export type KohakuPolicyFile = z.infer<typeof KohakuPolicyFileSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/**
 * Deep-merges two plain-object trees: an object key present on both sides recurses, an array or
 * primitive on `override` replaces `base`'s value wholesale (arrays are never concatenated or
 * merged element-by-element), and a key `override` omits keeps `base`'s value untouched. `undefined`
 * on `override` is treated as "absent" (keeps `base`), matching every field in this schema being
 * optional rather than nullable.
 */
function mergeDeep(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      merged[key] = mergeDeep(base[key], override[key]);
    }
    return merged;
  }
  return override;
}

/**
 * Deep-merges a tenant's `PolicySection` on top of `defaults` (objects merge key by key, recursing;
 * arrays and scalars in `override` replace `base`'s value wholesale). Used by host-core's
 * `createPolicyRuntime` to resolve `policyFor(session)`: `mergePolicySections(file.defaults,
 * file.tenants?.[tenant] ?? {})`. Exported so both the runtime and this module's own callers can share
 * one implementation rather than hand-rolling a merge.
 */
export function mergePolicySections(base: PolicySection, override: PolicySection): PolicySection {
  return mergeDeep(base, override) as PolicySection;
}

/**
 * A stable identity for a policy file: `sha256:<hex>` of the canonical JSON of the whole parsed (and
 * therefore already-normalized-by-Zod) file, matching the `sha256:<hex>` shape of `computeIntentHash`/
 * `computeSpecHash` (intent.ts / cache-key.ts). Two files that parse to the same value (whitespace,
 * key order) get the same `policyId`; any actual content change gets a different one. Used by the
 * `policy.applied` audit event (lineage, task 9) to detect "did the effective policy actually change"
 * across a `reload`.
 */
export async function computePolicyId(file: KohakuPolicyFile): Promise<string> {
  const hex = await sha256Hex(canonicalStringify(file));
  return `sha256:${hex}`;
}
