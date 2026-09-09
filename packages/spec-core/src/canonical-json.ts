import type { JsonValue } from "./schema/json.js";

/**
 * Deterministic serialization: JSON-encode with object keys sorted at every depth.
 * Equal values always produce the same byte sequence (the basis for hashing, cache keys, and diffs).
 * undefined / functions are dropped by the same rules as JSON.stringify.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    // NaN / Infinity collapse to null in JSON and would collide on the same hash as a genuine null.
    // This is a safeguard for direct calls that bypass parse (passing program-generated values
    // straight into canonicalStringify / computeSpecHash / computeStructureHash / normalizeJsonValue).
    // The parse path is already covered because zod's z.number() rejects NaN / Infinity.
    throw new TypeError(`canonical JSON cannot represent a non-finite number: ${String(value)}`);
  }
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
  }
  return value;
}

/** Returns a JSON value with keys sorted and undefined removed (the canonical form for display / storage). */
export function normalizeJsonValue<T extends JsonValue>(value: T): T {
  return sortDeep(value) as T;
}

/**
 * Because spec-core is an environment-neutral package that runs on both the browser and Node, it
 * avoids depending on the DOM lib or @types/node and reaches global APIs via structural typing over
 * globalThis. (TextEncoder / WebCrypto exist on Node 20+ and in every modern browser.)
 */
const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(input: string): Uint8Array };
  crypto: { subtle: { digest(alg: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> } };
};

const encoder = new runtime.TextEncoder();

/** sha256 via WebCrypto (common to Node 20+ and browsers; no dependency on node:crypto). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await runtime.crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
