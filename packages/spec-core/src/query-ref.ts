/**
 * Parsing and canonicalization of the query:// URI scheme. Environment-neutral (no DOM / node
 * dependency; encodeURIComponent / decodeURIComponent are ECMAScript globals present in every
 * environment).
 *
 * The **single definition site** of canonicalization (key sorting) lives here (spec-core).
 * data-binding re-exports it, and resolveBoundRef / enumerateBindVariants (bind.ts) use the same
 * functions. That the effective refs the client sends, the capability variant enumeration, and the
 * host's base-ref verification all produce the same canonical form is a security invariant of two-way
 * binding; if canonicalization were defined twice, this invariant would break (drift causing
 * authorization bypass / spurious 403s).
 */

export interface QueryRef {
  source: string;
  /** Kept encoded (not decoded; formatQueryRef fills it back in verbatim). */
  path: string;
  /** Keys/values are decoded. An empty-value parameter `?a` is kept as value "" (canonical form is `?a=`). */
  params: Record<string, string>;
  /** The canonical-form URI (parameters key-sorted). */
  raw: string;
}

export class QueryRefError extends Error {
  constructor(uri: string, reason: string) {
    super(`invalid query ref "${uri}": ${reason}`);
    this.name = "QueryRefError";
  }
}

const REF_RE = /^query:\/\/([a-z0-9_-]+)\/([^?#]+)(?:\?(.*))?$/;

/**
 * Parses the query:// URI scheme.
 * Example: query://sales/summary?fy=2026&groupBy=region&q=3
 */
export function parseQueryRef(uri: string): QueryRef {
  const m = REF_RE.exec(uri);
  if (m == null) {
    throw new QueryRefError(uri, "expected query://<source>/<path>?<params>");
  }
  const [, source, path, query] = m as unknown as [string, string, string, string | undefined];
  // Contract: source is constrained by the regex [a-z0-9_-]+ and is alphanumeric-plus-symbols only
  // (no encoding needed, safe). path (m[2]) is kept "still encoded". We do not decode it here because
  // formatQueryRef fills path back in verbatim (invariant across a round trip), and a path containing
  // ? or # is already rejected by REF_RE's [^?#]+. Only the params keys/values are decoded and kept.
  const params: Record<string, string> = {};
  if (query != null && query.length > 0) {
    for (const pair of query.split("&")) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) {
        // Contract: an empty-value parameter (a form without `=`, like `?a`) is kept as value "".
        // As a result the canonical form normalizes to `?a=` (formatQueryRef always emits key=value form).
        params[decodeURIComponent(pair)] = "";
      } else {
        params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
      }
    }
  }
  const ref: Omit<QueryRef, "raw"> = { source, path, params };
  return { ...ref, raw: formatQueryRef(ref) };
}

/** Returns the canonical-form (key-sorted, encoded) URI. The same reference always yields the same string. */
export function formatQueryRef(ref: Omit<QueryRef, "raw">): string {
  const query = Object.keys(ref.params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(ref.params[k]!)}`)
    .join("&");
  return `query://${ref.source}/${ref.path}${query.length > 0 ? `?${query}` : ""}`;
}
