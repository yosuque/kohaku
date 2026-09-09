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
  operation: { kind: string; artifactId?: string; intentHash?: string },
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
