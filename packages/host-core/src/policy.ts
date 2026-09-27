import type { BudgetCheckContext, ComposeBudget, ComposePolicy } from "@kohaku-ui/composer";
import {
  canonicalStringify,
  computePolicyId,
  type KohakuPolicyFile,
  KohakuPolicyFileSchema,
  mergePolicySections,
  type PolicySection,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitStore,
  type SessionContext,
} from "@kohaku-ui/spec-core";
import type { DailyTokenLedger } from "./daily-token-ledger.js";
import { createRateLimiter } from "./rate-limit.js";

/** `PolicySection.compose`, unwrapped from its optional. */
type PolicyComposeData = NonNullable<PolicySection["compose"]>;
/** `PolicySection.compose.budget`, unwrapped from its optional. */
type PolicyBudgetData = NonNullable<PolicyComposeData["budget"]>;

/**
 * Environment-neutral half of the Policy-as-Code runtime (design.md #69/#70): parses/validates a
 * policy file and layers it onto a product-supplied base `ComposePolicy`. Deliberately has no
 * `node:fs` import — `loadPolicyFile` (which does) lives in the sibling `policy-node.js` module,
 * exposed only via the `@kohaku-ui/host-core/policy-node` subpath, so importing this file (or the
 * package's main entry point, which re-exports it) never pulls a Node-only API into a consumer with a
 * non-Node tsconfig.
 */

/** A parsed and validated policy file, paired with its stable identity. */
export interface ParsedPolicy {
  file: KohakuPolicyFile;
  policyId: string;
}

/** Validates `json` against `KohakuPolicyFileSchema` and computes its `policyId`. Throws a ZodError on invalid input (the caller decides how to surface it — see `loadPolicyFile` for the file-reading counterpart). */
export async function parsePolicy(json: unknown): Promise<ParsedPolicy> {
  const file = KohakuPolicyFileSchema.parse(json);
  const policyId = await computePolicyId(file);
  return { file, policyId };
}

/**
 * The `policy.applied` audit event (design.md #69; SPEC is not affected — this is a host-side
 * operational concern). Fired by `reload()` only when the effective `policyId` actually changes
 * (never on a no-op reload — comparing byte-for-byte identical content, including reloading the exact
 * same file twice, is *not* an audit-worthy event). `@kohaku-ui/lineage`'s glue for recording this as a
 * real lineage event (the "policy.applied" event *type* itself is owned by lineage, not this package —
 * see AGENTS.md's "the event vocabulary is owned by @kohaku-ui/lineage") is a later commit on this
 * branch.
 */
export interface PolicyAppliedEvent {
  policyId: string;
  previousPolicyId: string | undefined;
  version: number;
  label: string | undefined;
  /** Dot-separated paths (e.g. `"defaults.compose.allowL2"`, `"tenants.tenant-a.compose.allowL2"`) whose value differs between the previous and new file. */
  changedPaths: string[];
  /** Every tenant key declared in the new file's `tenants` (not just the changed ones — a full roster snapshot at the time of this change). */
  tenants: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** Deep-equality check for one leaf value (object recursion is handled by the caller; this compares everything else, arrays included, as a single unit). */
function leafEquals(a: unknown, b: unknown): boolean {
  return canonicalStringify(a ?? null) === canonicalStringify(b ?? null);
}

/**
 * Collects the dot-separated paths whose value differs between `previous` and `next` (recursing into
 * plain objects; every other value, including arrays, is compared as a single leaf — a role's pattern
 * list changing is reported as one changed path, not diffed element by element). `previous` may be
 * `undefined` (the very first `reload`, or a runtime constructed without ever loading a prior file) —
 * every path present in `next` is then reported as changed.
 */
function diffPolicyPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (isPlainObject(previous) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const childPrefix = prefix === "" ? key : `${prefix}.${key}`;
      paths.push(...diffPolicyPaths(previous[key], next[key], childPrefix));
    }
    return paths;
  }
  return leafEquals(previous, next) ? [] : [prefix];
}

/** The merged `PolicySection` (`defaults` deep-merged with `tenants[tenant]`, tenant override winning) for one tenant. `undefined` tenant resolves to `defaults` alone. */
function resolveSection(file: KohakuPolicyFile, tenant: string | undefined): PolicySection {
  const tenantSection = tenant != null ? file.tenants?.[tenant] : undefined;
  return mergePolicySections(file.defaults, tenantSection ?? {});
}

/** Combines two optional `ComposeBudget.check` hooks: `base` runs first (its denial wins outright), `extra` runs only when `base` allows (or is absent). `undefined` when both are `undefined`. */
function combineChecks(base: ComposeBudget["check"], extra: ComposeBudget["check"]): ComposeBudget["check"] {
  if (base == null) return extra;
  if (extra == null) return base;
  return (ctx?: BudgetCheckContext) => {
    const verdict = base(ctx);
    return verdict.allow ? extra(ctx) : verdict;
  };
}

/** Combines two optional `ComposeBudget.onUsage` hooks: both run, `base` first. `undefined` when both are `undefined`. */
function combineOnUsage(
  base: ComposeBudget["onUsage"],
  extra: ComposeBudget["onUsage"],
): ComposeBudget["onUsage"] {
  if (base == null) return extra;
  if (extra == null) return base;
  return async (info) => {
    await base(info);
    await extra(info);
  };
}

/** Builds the `check`/`onUsage` pair enforcing `dailyTokens` against `ledger`, keyed by `tenant ?? ""`. */
function createDailyTokensBudgetHooks(
  ledger: DailyTokenLedger,
  tenant: string | undefined,
  dailyTokens: number,
): Pick<ComposeBudget, "check" | "onUsage"> {
  const key = tenant ?? "";
  return {
    check: () => {
      const spent = ledger.spent(key);
      if (spent >= dailyTokens) {
        return {
          allow: false,
          reason: `Budget exceeded: daily token threshold ${dailyTokens} reached (spent ${spent})`,
        };
      }
      return { allow: true };
    },
    onUsage: ({ usage }) => {
      ledger.record(key, usage.inputTokens + usage.outputTokens);
    },
  };
}

/**
 * Assembles the effective `ComposeBudget` for one tenant: `perCompose`/`deadlineMs` come from the
 * policy file's `compose.budget` when set, else fall back to the base policy's own; `dailyTokens` (a
 * policy-file-only concept — `ComposeBudget` itself has no such field) is layered on top as an
 * additional `check`/`onUsage` pair backed by `ledger`, combined with (not replacing) whatever `check`/
 * `onUsage` the base policy already supplies. `undefined` when nothing at all is set (byte-identical to
 * a `ComposePolicy` that never touches `budget`).
 */
function buildEffectiveBudget(
  base: ComposeBudget | undefined,
  data: PolicyBudgetData | undefined,
  tenant: string | undefined,
  ledger: DailyTokenLedger | undefined,
): ComposeBudget | undefined {
  const perCompose = data?.perCompose ?? base?.perCompose;
  const deadlineMs = data?.deadlineMs ?? base?.deadlineMs;
  let check = base?.check;
  let onUsage = base?.onUsage;
  if (data?.dailyTokens != null && ledger != null) {
    const daily = createDailyTokensBudgetHooks(ledger, tenant, data.dailyTokens);
    check = combineChecks(check, daily.check);
    onUsage = combineOnUsage(onUsage, daily.onUsage);
  }
  if (perCompose == null && deadlineMs == null && check == null && onUsage == null) return undefined;
  return {
    ...(perCompose != null ? { perCompose } : {}),
    ...(deadlineMs != null ? { deadlineMs } : {}),
    ...(check != null ? { check } : {}),
    ...(onUsage != null ? { onUsage } : {}),
  };
}

/** Layers `data` (the policy file's merged `compose` section for this tenant) onto `base` (the product-supplied `ComposePolicy`, which owns every function-shaped field). Only the keys `data` actually sets override `base`'s own value (design.md #69). */
function buildEffectivePolicy(
  file: KohakuPolicyFile,
  tenant: string | undefined,
  base: ComposePolicy,
  ledger: DailyTokenLedger | undefined,
): ComposePolicy {
  const data = resolveSection(file, tenant).compose ?? {};
  const budget = buildEffectiveBudget(base.budget, data.budget, tenant, ledger);
  return {
    ...base,
    ...(data.allowL2 !== undefined ? { allowL2: data.allowL2 } : {}),
    ...(data.maxRepairAttempts !== undefined ? { maxRepairAttempts: data.maxRepairAttempts } : {}),
    ...(data.refConstraint !== undefined ? { refConstraint: data.refConstraint } : {}),
    ...(data.effort !== undefined ? { effort: data.effort } : {}),
    ...(data.outputLanguage !== undefined ? { outputLanguage: data.outputLanguage } : {}),
    ...(data.cacheFailure !== undefined ? { cacheFailure: data.cacheFailure } : {}),
    ...(data.ttlSeconds !== undefined ? { ttlSeconds: data.ttlSeconds } : {}),
    ...(budget !== undefined ? { budget } : {}),
  };
}

/** One `PolicyRuntime.rateLimiter.take` call's parameters. `routeClass` is the policy file's fixed rate-limit vocabulary (schema/policy.ts's `PolicyRateLimitsSchema`). */
export interface PolicyRateLimiterTakeParams {
  tenant?: string;
  principal?: string;
  routeClass: "compose" | "action" | "resolve";
  cost?: number;
}

/** The `rateLimiter` a `PolicyRuntime` exposes: resolves the effective `RateLimitRule` for the tenant/routeClass from the current policy file, and always allows when none is configured (rate limiting is opt-in per route class) or when no `RateLimitStore` was supplied to `createPolicyRuntime` at all. */
export interface PolicyRateLimiter {
  take(params: PolicyRateLimiterTakeParams): Promise<RateLimitResult>;
}

export interface PolicyRuntime {
  /** The effective `ComposePolicy` for `session.tenant` (`basePolicyFor(tenant)` with the policy file's merged `compose` section layered on top). Memoized per (tenant, `basePolicyFor`'s returned object) pair — a caller whose `basePolicyFor` itself returns a stable object per tenant gets the identical `ComposePolicy` object back across calls, until the next `reload`. */
  policyFor(session?: SessionContext): ComposePolicy;
  rateLimiter: PolicyRateLimiter;
  /** The effective governance roles map (`GovernancePolicy.roles`'s shape, host-rest) for `tenant`. `{}` when neither `defaults` nor the tenant's section declares `governance.roles` (deny-by-default, matching `createGovernancePolicy`'s own behavior on an empty map). */
  rolesFor(tenant?: string): Record<string, readonly string[]>;
  /** The current file's `policyId` (`sha256:<hex>`). Live: reflects the most recent `reload`. */
  readonly policyId: string;
  /** Replaces the effective policy file. Fires `audit` (if wired) with a `PolicyAppliedEvent` — but only when the new `policyId` actually differs from the current one; reloading byte-identical content is a no-op (no event, memoized `policyFor` results are kept). */
  reload(file: KohakuPolicyFile, actor?: string): Promise<void>;
}

export interface CreatePolicyRuntimeOptions {
  file: KohakuPolicyFile;
  /**
   * The product-supplied base `ComposePolicy` per tenant — the home for every function-shaped setting
   * (`routeTier`, `fewShot`, `designSystem`, `fixedSpecs`, `l2Smoke`, `selectComponents`, `extraRules`;
   * design.md #69), which the policy file's `compose` section is layered on top of. Omitted = an empty
   * base policy for every tenant (the policy file becomes the sole source of `ComposePolicy` data).
   */
  basePolicyFor?: (tenant?: string) => ComposePolicy;
  /** Backs a `compose.budget.dailyTokens` check/onUsage pair. Only needed when some section actually declares `dailyTokens`; omitted, `dailyTokens` is silently not enforced. */
  ledger?: DailyTokenLedger;
  /** Backs `rateLimiter`. Only needed when some section actually declares `rateLimits`; omitted, `rateLimiter.take` always allows. */
  rateLimitStore?: RateLimitStore;
  /** Fired by `reload()`; see `PolicyRuntime.reload`'s doc. `actor` is `reload`'s own second argument, threaded through unchanged (never inspected by this module) — the caller's lineage-wiring glue is expected to place it on the recorded event's `actor` field, not inside the payload. */
  audit?: (event: PolicyAppliedEvent, actor: string | undefined) => void | Promise<void>;
}

interface PolicyForMemoEntry {
  base: ComposePolicy;
  policyId: string;
  effective: ComposePolicy;
}

/**
 * Builds the runtime half of Policy as Code: resolves an effective `ComposePolicy` per tenant (layering
 * the policy file's data onto a product-supplied base — design.md #69), a rate limiter reading the
 * policy file's `rateLimits` section, the effective governance roles per tenant, and a `reload` that
 * replaces the file and audits the change (design.md #70 covers the companion cache-isolation half —
 * `policyFingerprint`'s `tierGate` row — which this runtime does not itself touch: `policyFor`'s
 * returned `ComposePolicy` is consumed by `compose()` exactly like a hand-written one, so the existing
 * fingerprint machinery already separates the cache correctly for whatever `allowL2`/`routeTier` this
 * runtime ends up resolving).
 */
export async function createPolicyRuntime(options: CreatePolicyRuntimeOptions): Promise<PolicyRuntime> {
  let currentFile = options.file;
  let currentPolicyId = await computePolicyId(currentFile);
  const memo = new Map<string, PolicyForMemoEntry>();

  function policyFor(session?: SessionContext): ComposePolicy {
    const tenant = session?.tenant;
    const key = tenant ?? "";
    const base = options.basePolicyFor?.(tenant) ?? {};
    const cached = memo.get(key);
    if (cached != null && cached.base === base && cached.policyId === currentPolicyId) {
      return cached.effective;
    }
    const effective = buildEffectivePolicy(currentFile, tenant, base, options.ledger);
    memo.set(key, { base, policyId: currentPolicyId, effective });
    return effective;
  }

  const innerRateLimiter =
    options.rateLimitStore != null ? createRateLimiter(options.rateLimitStore) : undefined;
  const rateLimiter: PolicyRateLimiter = {
    async take({ tenant, principal, routeClass, cost }) {
      if (innerRateLimiter == null) return { allow: true };
      const rule: RateLimitRule | undefined = resolveSection(currentFile, tenant).rateLimits?.[routeClass];
      if (rule == null) return { allow: true };
      return innerRateLimiter.take({ tenant, principal, routeClass, rule, cost });
    },
  };

  function rolesFor(tenant?: string): Record<string, readonly string[]> {
    return resolveSection(currentFile, tenant).governance?.roles ?? {};
  }

  async function reload(file: KohakuPolicyFile, actor?: string): Promise<void> {
    const previousFile = currentFile;
    const previousPolicyId = currentPolicyId;
    const policyId = await computePolicyId(file);
    currentFile = file;
    currentPolicyId = policyId;
    memo.clear();
    if (policyId === previousPolicyId) return; // dedup: byte-identical content is a no-op, no event
    const event: PolicyAppliedEvent = {
      policyId,
      previousPolicyId,
      version: file.version,
      label: file.label,
      changedPaths: diffPolicyPaths(previousFile, file),
      tenants: Object.keys(file.tenants ?? {}),
    };
    await options.audit?.(event, actor);
  }

  return {
    policyFor,
    rateLimiter,
    rolesFor,
    get policyId() {
      return currentPolicyId;
    },
    reload,
  };
}
