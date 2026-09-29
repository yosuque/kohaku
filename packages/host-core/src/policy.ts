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
import type { RateLimiterErrorInfo } from "./rate-limit.js";
import { createRateLimiter, DEFAULT_MAX_MEMORY_ENTRIES } from "./rate-limit.js";

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
 * operational concern). Fired once by `createPolicyRuntime` for the file the runtime starts with
 * (`previousPolicyId` is `undefined`, `changedPaths` lists every top-level key of that file), and then by
 * `reload()` only when the effective `policyId` actually changes (never on a no-op reload — comparing
 * byte-for-byte identical content, including reloading the exact same file twice, is *not* an
 * audit-worthy event). The "policy.applied" event *type* is owned by `@kohaku-ui/lineage`, and
 * `Lineage.policyApplied` records this event as-is.
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
  const tenantSection = declaresTenant(file, tenant) ? file.tenants?.[tenant] : undefined;
  return mergePolicySections(file.defaults, tenantSection ?? {});
}

/** True when `file.tenants` declares its own section for `tenant` (an own key only: `"constructor"` / `"__proto__"` are not tenants). */
function declaresTenant(file: KohakuPolicyFile, tenant: string | undefined): tenant is string {
  return tenant != null && file.tenants != null && Object.hasOwn(file.tenants, tenant);
}

/**
 * The memo key of a tenant's resolved `PolicySection`: the tenant id when the file declares a section
 * for it, else one shared key — an undeclared tenant resolves to `defaults` alone, so the many tenant
 * ids a caller-controlled header can produce all share a single entry instead of growing the memo.
 */
function sectionKeyOf(file: KohakuPolicyFile, tenant: string | undefined): string {
  return declaresTenant(file, tenant) ? `t:${tenant}` : "d";
}

/**
 * Fails fast when `file` declares a limit this runtime has no dependency to enforce: a
 * `compose.budget.dailyTokens` needs a `ledger`, a `rateLimits` rule needs a `rateLimitStore`. Without
 * this check such a section would be accepted and then silently never enforced.
 */
function assertDependenciesFor(
  file: KohakuPolicyFile,
  deps: { ledger?: DailyTokenLedger; rateLimitStore?: RateLimitStore },
): void {
  const sections: [string, PolicySection][] = [
    ["defaults", file.defaults],
    ...Object.entries(file.tenants ?? {}).map(([tenant, section]): [string, PolicySection] => [
      `tenants.${tenant}`,
      section,
    ]),
  ];
  for (const [where, section] of sections) {
    if (deps.ledger == null && section.compose?.budget?.dailyTokens != null) {
      throw new Error(
        `Policy file declares ${where}.compose.budget.dailyTokens but createPolicyRuntime was given no \`ledger\`; the limit would never be enforced. Pass \`ledger: createDailyTokenLedger()\` or remove the setting.`,
      );
    }
    const rules = section.rateLimits;
    if (
      deps.rateLimitStore == null &&
      rules != null &&
      (rules.compose != null || rules.action != null || rules.resolve != null)
    ) {
      throw new Error(
        `Policy file declares ${where}.rateLimits but createPolicyRuntime was given no \`rateLimitStore\`; the limits would never be enforced. Pass \`rateLimitStore: createMemoryRateLimitStore()\` (or your own RateLimitStore) or remove the setting.`,
      );
    }
  }
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

/**
 * Builds the `check`/`onUsage` pair enforcing `dailyTokens` against `ledger`, keyed by `tenant ?? ""`.
 *
 * **This is a soft limit under concurrency, by design (design.md #69)**: `check` is read-only (reads
 * `ledger.spent(key)`) and `onUsage` writes (`ledger.record`) only after a compose actually completes --
 * there is no reservation step between the two, because `ComposeBudget.check` is a synchronous,
 * side-effect-free contract (composer calls it before starting generation and must be able to call it
 * cheaply and repeatedly). N composes for the same tenant in flight at once can therefore all read the
 * same `spent()` value and all pass `check`, before any of them has recorded its own usage -- the
 * day's total can overshoot `dailyTokens` by at most `(concurrent in-flight generations) x (the
 * per-compose token ceiling)`. A deployment that needs a tighter effective cap under concurrent load
 * should also set `compose.budget.perCompose.stopAfterTokens`, which bounds that per-generation
 * ceiling (see the doc comment on `PolicyBudgetSchema.dailyTokens`, spec-core's schema/policy.ts, and
 * the test at test/policy.test.ts's "dailyTokens is a soft limit" for a worked example of the bound).
 */
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

/** Layers `section.compose` (the policy file's merged section for this tenant) onto `base` (the product-supplied `ComposePolicy`, which owns every function-shaped field). Only the keys `data` actually sets override `base`'s own value (design.md #69). */
function buildEffectivePolicy(
  section: PolicySection,
  tenant: string | undefined,
  base: ComposePolicy,
  ledger: DailyTokenLedger | undefined,
): ComposePolicy {
  const data = section.compose ?? {};
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
  /**
   * Replaces the effective policy file. Fires `audit` (if wired) with a `PolicyAppliedEvent` — but only when the new `policyId` actually differs from the current one; reloading byte-identical content is a no-op (no event, memoized `policyFor` results are kept). Rejects, leaving the previous policy in force, when `file` declares `dailyTokens` / `rateLimits` and the runtime was built without the `ledger` / `rateLimitStore` that would enforce it (see `CreatePolicyRuntimeOptions`).
   */
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
  /**
   * Backs a `compose.budget.dailyTokens` check/onUsage pair. Required when any section declares
   * `dailyTokens`: `createPolicyRuntime` (and `reload`) throws a configuration error rather than accept a
   * file whose limit would silently never be enforced. The ledger is in-process only, so the budget applies
   * per host instance (see `DailyTokenLedger`).
   */
  ledger?: DailyTokenLedger;
  /**
   * Backs `rateLimiter`. Required when any section declares `rateLimits`: `createPolicyRuntime` (and
   * `reload`) throws a configuration error rather than accept a file whose limits would silently never be
   * enforced. Omitted (with no `rateLimits` declared), `rateLimiter.take` always allows.
   */
  rateLimitStore?: RateLimitStore;
  /** Forwarded as `createRateLimiter`'s `timeoutMs`: how long `rateLimiter.take` waits for `rateLimitStore.take` before failing open. Default `DEFAULT_RATE_LIMIT_TIMEOUT_MS`. */
  rateLimitTimeoutMs?: number;
  /**
   * Forwarded as `createRateLimiter`'s `onError`: fired (fire-and-forget, `notifyHook`'s convention)
   * whenever `rateLimitStore.take` throws. `rateLimiter.take` itself always fails open (the request is
   * still allowed) regardless of whether this is wired — omitting it does not change request handling,
   * it only means a `RateLimitStore` outage goes unobserved. Wire it to the same `onError`/observability
   * hook the rest of your host already uses (e.g. `KohakuHostDeps.onError` / the compose observer's
   * `onError`) so a rate-limit backend failure surfaces the same way any other fail-open failure does.
   */
  onRateLimitError?: (info: RateLimiterErrorInfo) => void | Promise<void>;
  /** Fired once by `createPolicyRuntime` for the starting file (`actor` `undefined`, `previousPolicyId` `undefined`) and by `reload()` on every effective change; see `PolicyAppliedEvent` and `PolicyRuntime.reload`'s doc. `actor` is `reload`'s own second argument, threaded through unchanged (never inspected by this module) — the caller's lineage-wiring glue is expected to place it on the recorded event's `actor` field, not inside the payload. A rejection from the startup call propagates out of `createPolicyRuntime`, the same way one from `reload` propagates out of `reload`. */
  audit?: (event: PolicyAppliedEvent, actor: string | undefined) => void | Promise<void>;
}

interface PolicyForMemoEntry {
  base: ComposePolicy;
  policyId: string;
  effective: ComposePolicy;
}

/** Builds the `policy.applied` event for a change from `previousFile` (`undefined` = the runtime's starting file) to `file`. */
function buildAppliedEvent(
  previousFile: KohakuPolicyFile | undefined,
  previousPolicyId: string | undefined,
  file: KohakuPolicyFile,
  policyId: string,
): PolicyAppliedEvent {
  return {
    policyId,
    previousPolicyId,
    version: file.version,
    label: file.label,
    changedPaths: diffPolicyPaths(previousFile ?? {}, file),
    tenants: Object.keys(file.tenants ?? {}),
  };
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
 *
 * Throws when `options.file` declares `dailyTokens` / `rateLimits` without the matching `ledger` /
 * `rateLimitStore` (see `CreatePolicyRuntimeOptions`), and fires `audit` once for the starting file.
 */
export async function createPolicyRuntime(options: CreatePolicyRuntimeOptions): Promise<PolicyRuntime> {
  assertDependenciesFor(options.file, options);
  let currentFile = options.file;
  let currentPolicyId = await computePolicyId(currentFile);
  const memo = new Map<string, PolicyForMemoEntry>();
  const sectionMemo = new Map<string, PolicySection>();

  /** `resolveSection`, memoized per `sectionKeyOf` (cleared on every effective change): the deep merge runs once per declared tenant, not once per request. */
  function sectionFor(tenant: string | undefined): PolicySection {
    const key = sectionKeyOf(currentFile, tenant);
    let section = sectionMemo.get(key);
    if (section == null) {
      section = resolveSection(currentFile, tenant);
      sectionMemo.set(key, section);
    }
    return section;
  }

  function policyFor(session?: SessionContext): ComposePolicy {
    const tenant = session?.tenant;
    const key = tenant ?? "";
    const base = options.basePolicyFor?.(tenant) ?? {};
    const cached = memo.get(key);
    if (cached != null && cached.base === base && cached.policyId === currentPolicyId) {
      memo.delete(key); // reinsert to mark as most-recently-used
      memo.set(key, cached);
      return cached.effective;
    }
    const effective = buildEffectivePolicy(sectionFor(tenant), tenant, base, options.ledger);
    memo.delete(key);
    if (memo.size >= DEFAULT_MAX_MEMORY_ENTRIES) {
      // The key is a caller-controlled tenant header value: bound the memo with LRU eviction (a Map
      // iterates in insertion order, so the first key is the least recently used).
      const oldestKey = memo.keys().next().value;
      if (oldestKey !== undefined) memo.delete(oldestKey);
    }
    memo.set(key, { base, policyId: currentPolicyId, effective });
    return effective;
  }

  const innerRateLimiter =
    options.rateLimitStore != null
      ? createRateLimiter(
          options.rateLimitStore,
          options.onRateLimitError,
          undefined,
          options.rateLimitTimeoutMs != null ? { timeoutMs: options.rateLimitTimeoutMs } : {},
        )
      : undefined;
  const rateLimiter: PolicyRateLimiter = {
    async take({ tenant, principal, routeClass, cost }) {
      if (innerRateLimiter == null) return { allow: true };
      const rule: RateLimitRule | undefined = sectionFor(tenant).rateLimits?.[routeClass];
      if (rule == null) return { allow: true };
      return innerRateLimiter.take({ tenant, principal, routeClass, rule, cost });
    },
  };

  function rolesFor(tenant?: string): Record<string, readonly string[]> {
    return sectionFor(tenant).governance?.roles ?? {};
  }

  async function reload(file: KohakuPolicyFile, actor?: string): Promise<void> {
    assertDependenciesFor(file, options);
    const policyId = await computePolicyId(file);
    if (policyId === currentPolicyId) return; // dedup: byte-identical content is a no-op, no event, memos kept
    const previousFile = currentFile;
    const previousPolicyId = currentPolicyId;
    currentFile = file;
    currentPolicyId = policyId;
    memo.clear();
    sectionMemo.clear();
    await options.audit?.(buildAppliedEvent(previousFile, previousPolicyId, file, policyId), actor);
  }

  await options.audit?.(buildAppliedEvent(undefined, undefined, currentFile, currentPolicyId), undefined);

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
