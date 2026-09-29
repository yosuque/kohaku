import type { DomainPort } from "@kohaku-ui/spec-core";
import type { OperationIndex } from "./operation-index.js";

/** A memoized accessor for the write-action names a DomainPort actually exposes. */
export type AllowedActions = () => Promise<ReadonlySet<string>>;

/**
 * Builds a memoizing `AllowedActions` closure for one `DomainPort` — built once per host attach / deps
 * object (`listOperations()` is async and must not be re-awaited on every compose / action call). Shared by
 * both host profiles wherever a caller-supplied action name must be checked against the DomainPort's real
 * operation list:
 * - REST/MCP capability issuance (host-core's `issueCapabilityForSpec`'s `allowedActions` option) drops a
 *   Spec-declared write scope whose action is not a DomainPort operation, hardening against a
 *   hallucinated/injected `action.invoke` action name becoming a bearer write scope.
 *
 * On rejection the cached promise is discarded so the next call retries against the DomainPort, and the
 * rejection propagates to the caller — each call site decides its own fail-open/fail-closed response and
 * reports it under its own endpoint name (REST's reportHostError / MCP's reportMcpError already do this).
 * The optional `onError` is a coarse, endpoint-less observability fallback fired (fire-and-forget) whenever
 * the underlying `listOperations()` call rejects, for a caller that has no per-call-site endpoint to report
 * under.
 */
export function createAllowedActions(domain: DomainPort, onError?: (error: unknown) => void): AllowedActions {
  let cached: Promise<ReadonlySet<string>> | undefined;
  return () => {
    if (cached == null) {
      const promise = domain.listOperations().then((ops) => new Set(ops.map((op) => op.name)));
      promise.catch((e) => {
        if (cached === promise) cached = undefined;
        onError?.(e);
      });
      cached = promise;
    }
    return cached;
  };
}

/**
 * An `AllowedActions` derived from an already-built `OperationIndex` (the keys of its by-name map) instead of a
 * second, independently memoized `listOperations()` call -- a host that already keeps an index for its
 * action gate uses this so the capability write-scope filter and the gate can never disagree about which
 * actions exist. Every declared operation counts, including one whose `paramsSchema` failed validation (that
 * operation alone is unusable; its write scope is unaffected), so a bad schema never changes the set. It
 * inherits the index's one failure mode: `listOperations()` rejecting rejects here too, and callers treat
 * that as `createAllowedActions`'s own rejection (fail-closed for write scopes).
 */
export function allowedActionsFromIndex(index: OperationIndex): AllowedActions {
  return async () => new Set((await index()).keys());
}
