import type { AuthzPort, Principal, Scope, UISpec } from "@kohaku-ui/spec-core";
import { collectCapabilityScopes } from "@kohaku-ui/spec-core";

/** Default capability TTL (seconds) when a host does not override it. Shared by the REST and MCP profiles. */
export const DEFAULT_CAPABILITY_TTL_SECONDS = 600;

/**
 * Raised (reported via `onDroppedAction`, never thrown) when a Spec-declared write scope's action name is not
 * among the DomainPort's `listOperations()` names. A hallucinated/injected `action.invoke` action name must not
 * become a bearer write scope, so it is silently excluded from the issued capability rather than granted —
 * `issueCapabilityForSpec` itself stays fail-open (the capability is still issued without that one scope).
 */
export class WriteScopeDroppedError extends Error {
  constructor(readonly action: string) {
    super(`write scope dropped: action "${action}" is not a DomainPort operation (listOperations)`);
    this.name = "WriteScopeDroppedError";
  }
}

export interface IssueCapabilityOptions {
  /**
   * Action names the DomainPort exposes (its `listOperations()` names). A write scope whose `ref` is not in
   * this set is dropped before issuance; read scopes are never affected. Leave undefined to skip filtering
   * (every write scope the Spec declares is issued as-is, unfiltered).
   */
  allowedActions?: ReadonlySet<string>;
  /** Called once per dropped write scope (fail-open: the capability is still issued, just without that scope). */
  onDroppedAction?: (action: string) => void;
}

/**
 * Issues a capability matching the Spec's declarations (components' read references + the write-through action
 * path). The scope-collection rules (read = bind variant enumeration / write = declared actions / variant cap)
 * are centralized in spec-core's collectCapabilityScopes (single source of truth), so both host profiles agree
 * on the issuance rule.
 *
 * When `options.allowedActions` is supplied, write scopes whose action is not a DomainPort operation
 * (`listOperations()`) are dropped before issuance — hardening against an LLM-generated `action.invoke` action
 * name flowing unvalidated into a bearer write scope. Read scopes are untouched by this filter.
 */
export async function issueCapabilityForSpec(
  authz: AuthzPort,
  principal: Principal,
  spec: UISpec,
  ttlSeconds: number = DEFAULT_CAPABILITY_TTL_SECONDS,
  options?: IssueCapabilityOptions,
): Promise<string> {
  const scopes = filterAllowedScopes(collectCapabilityScopes(spec), options);
  return authz.issueCapability(principal, scopes, { ttlSeconds });
}

/** Drops write scopes not covered by `options.allowedActions` (a no-op when it is undefined). */
function filterAllowedScopes(scopes: Scope[], options?: IssueCapabilityOptions): Scope[] {
  const allowedActions = options?.allowedActions;
  if (allowedActions == null) return scopes;
  return scopes.filter((scope) => {
    if (scope.kind !== "write" || allowedActions.has(scope.ref)) return true;
    options?.onDroppedAction?.(scope.ref);
    return false;
  });
}

/**
 * The fail-closed capability issuance shared by both host profiles (REST's issueSpecCapability wrapper and
 * MCP's composeAndPackage): resolves `allowedActions` (each host's memoized DomainPort.listOperations()
 * reader), then issues via issueCapabilityForSpec with that set as the write-scope filter. If
 * `allowedActions` itself rejects, the rejection is reported and the capability is still issued but
 * fail-closed for writes (an empty allowed set — every write scope is dropped); every dropped write scope is
 * reported as a WriteScopeDroppedError. Delivery proceeds either way (fail-open on both paths).
 * Contract: `report` must not reject — the dropped-action report (`onDroppedAction`) is fire-and-forgotten,
 * so a rejecting `report` would produce an unhandled rejection rather than propagating here.
 */
export async function issueSpecCapabilitySafely(
  authz: AuthzPort,
  principal: Principal,
  spec: UISpec,
  allowedActions: () => Promise<ReadonlySet<string>>,
  report: (error: unknown) => void | Promise<void>,
  ttlSeconds?: number,
): Promise<string> {
  let allowed: ReadonlySet<string>;
  try {
    allowed = await allowedActions();
  } catch (e) {
    await report(e);
    allowed = new Set();
  }
  return issueCapabilityForSpec(authz, principal, spec, ttlSeconds, {
    allowedActions: allowed,
    onDroppedAction: (action) => void report(new WriteScopeDroppedError(action)),
  });
}

/**
 * Issues a read capability covering an explicit set of resolved QueryHandle URIs, rather than a Spec's
 * declarations. Used where the caller already knows the effective refs ahead of a full Spec — e.g. REST's
 * streaming skeleton, which has no $ref until the final event. Refs are deduped before becoming scopes.
 */
export async function issueCapabilityForRefs(
  authz: AuthzPort,
  principal: Principal,
  refs: string[],
  ttlSeconds: number = DEFAULT_CAPABILITY_TTL_SECONDS,
): Promise<string> {
  const scopes = [...new Set(refs)].map((ref) => ({ kind: "read" as const, ref }));
  return authz.issueCapability(principal, scopes, { ttlSeconds });
}
