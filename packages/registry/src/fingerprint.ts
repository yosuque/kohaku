/**
 * Catalog fingerprint (a cache-key component). Cryptographic strength is not needed, so a synchronous
 * FNV-1a 64-bit is used. It is computed over the sorted join of "type@version" (native entries) or
 * "type@version#fnv1a64(html)" (sandbox-template entries, so a re-published artifact under the same
 * type@version is distinguished from the one it replaced). It always changes when a part is added,
 * revised, or (for a sandbox-template) re-published with different content.
 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface CatalogFingerprintEntry {
  type: string;
  version: string;
  implementation?: { kind: string; html?: string };
}

/** The per-entry identity string folded into the catalog fingerprint (exported for cross-checks). */
export function catalogEntryIdentity(entry: CatalogFingerprintEntry): string {
  return entry.implementation?.kind === "sandbox-template" && entry.implementation.html != null
    ? `${entry.type}@${entry.version}#${fnv1a64(entry.implementation.html)}`
    : `${entry.type}@${entry.version}`;
}

export function catalogFingerprint(entries: CatalogFingerprintEntry[]): string {
  const joined = entries
    .map((e) => catalogEntryIdentity(e))
    .sort()
    .join(",");
  return fnv1a64(joined);
}
