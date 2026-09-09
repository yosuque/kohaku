/**
 * The query:// URI canonicalization core (QueryRef / parseQueryRef / formatQueryRef / QueryRefError) is
 * centralized in spec-core. This avoids duplicating canonicalization and keeps the effective ref (resolveBoundRef),
 * capability variant enumeration, and the host's base-ref validation all on the same canonical form (drift would
 * cause authorization bypass / spurious 403 in two-way binding). data-binding re-exports it and owns only the
 * splitting of the reserved namespace (leading `_`), splitReservedParams, as a binding-layer concern.
 */
import { formatQueryRef, parseQueryRef, type QueryRef, QueryRefError } from "@kohaku-ui/spec-core";

export { formatQueryRef, parseQueryRef, type QueryRef, QueryRefError };

/** Reserved-parameter prefix for server-side paging/sort. */
export const RESERVED_PARAM_PREFIX = "_";

export interface SplitRef {
  /**
   * The base ref with reserved parameters (leading `_`) removed. It is the target of capability validation and
   * canonical caching, and matches the original Spec `$ref` (which contains no reserved parameters).
   */
  base: QueryRef;
  /** Reserved parameters with a leading `_` (`_cursor` / `_limit` / `_sort` / `_dir`, etc.). */
  reserved: Record<string, string>;
}

/**
 * Splits a ref into base (the canonical form with reserved parameters removed) and reserved (leading `_`).
 *
 * Capability validation is performed by **exact match** against `base.raw` (the canonical form without reserved
 * parameters = the original $ref the Spec declared), and reserved parameters are merged with `base.params` into
 * `domain.invoke` (the `_` namespace convention — a DomainPort invariant). A canonical URI with reserved parameters
 * added does not match the original ref (e.g. `…records?_limit=50&fy=2026` ≠ `…records?fy=2026`), so before
 * validation this split reduces it back to base.
 */
export function splitReservedParams(uri: string): SplitRef {
  const parsed = parseQueryRef(uri);
  const baseParams: Record<string, string> = {};
  const reserved: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.params)) {
    if (k.startsWith(RESERVED_PARAM_PREFIX)) reserved[k] = v;
    else baseParams[k] = v;
  }
  const baseCore: Omit<QueryRef, "raw"> = {
    source: parsed.source,
    path: parsed.path,
    params: baseParams,
  };
  return { base: { ...baseCore, raw: formatQueryRef(baseCore) }, reserved };
}

/** Known keys of the reserved namespace (SPEC §2.3). Only the wire representation of paging/sort is allowed. */
export const KNOWN_RESERVED_PARAMS: ReadonlySet<string> = new Set(["_cursor", "_limit", "_sort", "_dir"]);

/**
 * Throws if reserved contains any unknown `_` key (boundary defense).
 * The reserved namespace is dedicated to "reordering / slicing" and is outside capability validation, so passing an
 * unknown key straight through to the DomainPort would let an out-of-authorization parameter change "which data is returned".
 */
export function assertKnownReservedParams(reserved: Record<string, string>): void {
  for (const key of Object.keys(reserved)) {
    if (!KNOWN_RESERVED_PARAMS.has(key)) {
      // A `code` marks this as a deliberate, host-authored validation error (host-core's isTypedHostError),
      // so its message still reaches the caller (a 400 body / tool error) instead of collapsing to a generic
      // internal-error text on the hosts that route it through their catch-all error handling (MCP's
      // `${prefix}_resolve_binding`, which — unlike REST's /binding/resolve — has no dedicated try/catch
      // around this call).
      throw Object.assign(
        new Error(
          `unknown reserved parameter "${key}" is not allowed (allowed: _cursor / _limit / _sort / _dir)`,
        ),
        { code: "UNKNOWN_RESERVED_PARAM" },
      );
    }
  }
}
