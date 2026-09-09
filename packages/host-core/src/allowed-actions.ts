import type { DomainPort } from "@kohaku-ui/spec-core";

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
 * - The MCP `${prefix}_action` tool additionally rejects an unknown action name outright, before even
 *   attempting capability verification (defense in depth for a host that does not respect the tool's
 *   app-only visibility hint).
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
