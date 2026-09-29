import type { Principal } from "@kohaku-ui/spec-core";

/**
 * Declarative RBAC policy evaluator for the governance/audit plane (the concrete embodiment of #1).
 *
 * `KohakuHostDeps.authorizeGovernance` is where the framework only prescribes the "authorization join point"
 * (SPEC §6.1 governance-plane authorization [Draft]), while the evaluator's implementation is a product
 * responsibility. As a representative implementation, this module supplies an evaluator in which a "role ->
 * allowed operation" matrix can be written declaratively.
 *
 * Design principles:
 * - The evaluator returns a pure function `(principal, operation, tenant?) -> allow/deny`. Extracting the principal
 *   (role, etc.) from the request is the responsibility of the hook wiring (`KohakuHostDeps.auth`), and the
 *   evaluator only looks at principal.roles. This follows the governance-plane division of labor: role resolution
 *   is delegated to the product's authentication infrastructure.
 * - The default is "deny". An operation that matches none of any role's patterns is denied (likewise for unknown
 *   roles and no roles). Erring on the safe side (deny-by-default) makes a forgotten permission grant become
 *   "denied" rather than "unprotected".
 */

/**
 * The actual set of governance/audit-plane operation.kind values (the kinds `requireGovernance` in `routes.ts`
 * issues). Of the form `<domain>.<action>`. This is the single canonical source for operation.kind, and since
 * `requireGovernance`'s argument type references this union, a typo on the route side (e.g. `"lineage.raed"`) is
 * rejected at compile time.
 */
export const GOVERNANCE_OPERATION_KINDS = [
  "lineage.read",
  "analytics.read",
  "telemetry.write",
  "promotion.list",
  "promotion.evaluate",
  "promotion.get",
  "promotion.preview",
  "promotion.approve",
  "promotion.reject",
  "promotion.withdraw",
  "promotion.act",
  /**
   * Governance kind for `POST /promotions/reconcile` (#11): an operator escape hatch that forces the projection
   * recovery from snapshot authority on demand (the same recovery run at startup). Not scoped to one artifact
   * (it scans every tenant), so it is a dedicated kind rather than reusing `promotion.act`'s per-artifact shape.
   * A role granted via `promotion.*` or `*` already covers it (the sample's `reviewer` role, which already holds
   * `promotion.*`, needs no explicit change to also reach reconcile).
   */
  "promotion.reconcile",
  /**
   * Kind-scoped authorization for the generic action route (POST /promotions/:artifactId/actions): a caller
   * holding only `promotion.act` must not be able to record a judge verdict (`judge.result`), which would let
   * it spoof the judge outcome that the dedicated approve flow relies on. `promotion.act` remains the blanket
   * check for the route; this is the additional kind required specifically for `judge.result`.
   */
  "promotion.judge",
  "fixation.list",
  "fixation.proposals",
  "fixation.approve",
  "fixation.remove",
  /**
   * Governance kind for `POST /approvals` (design.md #63, SPEC ACT-APR-001 [Draft]): a caller must hold
   * this to mint an approval token for someone else's pending `"approve"`-tier action. Deliberately its
   * own kind (not folded into an existing `promotion.*`/`fixation.*` domain) -- approving a governed
   * Action is an independent authorization surface from the promotion/fixation pipelines.
   */
  "action.approve",
] as const;

/** The type of a governance operation.kind (an element of GOVERNANCE_OPERATION_KINDS). */
export type GovernanceOperationKind = (typeof GOVERNANCE_OPERATION_KINDS)[number];

/** The "domain" of a governance operation.kind (the part before the dot). Derived mechanically from GovernanceOperationKind. */
export type GovernanceDomain = GovernanceOperationKind extends `${infer D}.${string}` ? D : never;

/**
 * A description of the governance operation a route issues. `requireGovernance` receives this type, restricting kind
 * to the actual set. It is naturally assignable to the `authorizeGovernance` hook's signature (kind: string) (narrow type -> wide type).
 */
export interface GovernanceOperation {
  kind: GovernanceOperationKind;
  artifactId?: string;
  intentHash?: string;
  /**
   * The governed Action a `action.approve` operation would approve (the `POST /approvals` body's `action`), so an
   * `authorizeGovernance` hook can scope who may approve which action. Set only for that kind. The bundled
   * `createGovernancePolicy` is role-based and ignores it; a product hook that needs per-action approvers reads it.
   */
  action?: string;
}

/**
 * A policy pattern. Supports an exact-match operation.kind, `<domain>.*` (allow all within a domain), and `*`
 * (allow all). Since the type is derived from the actual set, typos in a pattern are also rejected at compile time.
 */
export type GovernancePattern = "*" | `${GovernanceDomain}.*` | GovernanceOperationKind;

/**
 * Declarative RBAC policy. A matrix of role name -> allowed patterns.
 * Example: `{ roles: { admin: ["*"], reviewer: ["promotion.*", "lineage.read"], viewer: ["lineage.read"] } }`
 */
export interface GovernancePolicy {
  roles: Record<string, readonly GovernancePattern[]>;
  /**
   * Optional tenant-scoping hook. When supplied, the evaluator additionally requires
   * `tenantOf(principal) === tenant` (the resolved tenant the route passes in) for every operation — a
   * mismatch denies regardless of role, so a role grant alone can no longer reach another tenant's
   * governance/audit plane. Omit it to keep the historical role-only behavior (a role holder may operate on
   * any tenant the host resolves).
   */
  tenantOf?: (principal: Principal) => string | undefined;
}

/**
 * The governance-plane authorization evaluator (a pure function assignable to `KohakuHostDeps.authorizeGovernance`).
 * operation.kind is received as `string` — to be assignable to the hook's signature (the product may pass any
 * kind). A kind outside the actual set matches no pattern and is denied (deny-by-default).
 */
export type GovernanceEvaluator = (
  principal: Principal,
  operation: { kind: string; artifactId?: string; intentHash?: string; action?: string },
  tenant?: string,
) => boolean;

/**
 * Builds an authorization evaluator from a declarative RBAC policy. Allowed if any of principal.roles matches
 * (multiple roles = the union of permissions = standard RBAC). Denied if no role matches.
 *
 * Scope note: without `policy.tenantOf`, the bundled evaluator is **role-based only** and ignores the
 * `tenant` argument (the third parameter of GovernanceEvaluator) — a principal holding a role may operate on
 * any tenant the host resolves. Supplying `tenantOf` closes that gap by additionally requiring
 * `tenantOf(principal) === tenant` (checked before the role match, so a tenant mismatch denies outright
 * regardless of role); omit it, or supply your own evaluator, if you need a different tenant-binding rule.
 */
export function createGovernancePolicy(policy: GovernancePolicy): GovernanceEvaluator {
  return (principal, operation, tenant) => {
    if (policy.tenantOf != null && policy.tenantOf(principal) !== tenant) return false;
    const roles = principal.roles ?? [];
    for (const role of roles) {
      const patterns = policy.roles[role];
      if (patterns == null) continue; // An unknown role has no permission (err toward deny).
      for (const pattern of patterns) {
        if (matchesPattern(pattern, operation.kind)) return true;
      }
    }
    return false;
  };
}

/** Match a pattern against an operation.kind. `*` allows all, `<domain>.*` allows all within a domain, otherwise exact match. */
function matchesPattern(pattern: string, kind: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const domain = pattern.slice(0, -2); // the domain, with ".*" removed
    return kind.startsWith(`${domain}.`);
  }
  return pattern === kind;
}

/**
 * Builds a `GovernanceEvaluator` from a per-tenant roles resolver (host-core's
 * `PolicyRuntime.rolesFor`, or any function of that same shape) instead of a static
 * `GovernancePolicy.roles` map -- so a role's grants can change per tenant (a Policy file's
 * `governance.roles` section, `@kohaku-ui/spec-core`'s `KohakuPolicyFileSchema`) and reflect a
 * `PolicyRuntime.reload()` on the very next call, unlike `createGovernancePolicy`, which bakes
 * `policy.roles` in once at construction time.
 *
 * `rolesFor` is resolved fresh on every evaluation (not memoized here): delegates to
 * `createGovernancePolicy` for the actual matching so the two evaluators never drift in behavior.
 * `rolesFor`'s patterns stay plain strings (host-core must not depend on `GovernancePattern`, which is
 * derived from this package's own `GovernanceOperationKind` -- see `PolicyRuntime.rolesFor`'s own doc
 * comment); an unrecognized pattern already fails `matchesPattern`'s structural check (deny-by-default),
 * so no validation is needed at this boundary either.
 *
 * `options.tenantOf` is forwarded to `createGovernancePolicy`: without it, a per-tenant role grant is resolved
 * against the tenant the *request* names, so a principal holding the role in tenant A could be granted through
 * tenant B's table. With it, `tenantOf(principal)` must equal the resolved tenant before any role is consulted.
 */
export function governancePolicyFromRoles(
  rolesFor: (tenant?: string) => Record<string, readonly string[]>,
  options: { tenantOf?: GovernancePolicy["tenantOf"] } = {},
): GovernanceEvaluator {
  const { tenantOf } = options;
  return (principal, operation, tenant) =>
    createGovernancePolicy({
      roles: rolesFor(tenant) as Record<string, readonly GovernancePattern[]>,
      ...(tenantOf != null ? { tenantOf } : {}),
    })(principal, operation, tenant);
}
