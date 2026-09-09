import { canonicalStringify, normalizeJsonValue, sha256Hex } from "./canonical-json.js";
import { type CanonicalIntent, IntentHashSchema } from "./schema/intent.js";
import type { JsonObject } from "./schema/json.js";

export interface IntentInput {
  canonical: string;
  params: JsonObject;
}

/**
 * Deterministic normalization of an already-structured Intent (deep key-sort of params, removing
 * undefined). This is distinct from the natural-language → Intent conversion (SemanticPort.normalize);
 * this only guarantees that "Intents with the same meaning produce the same byte sequence".
 */
export function normalizeIntent(intent: IntentInput): IntentInput {
  return {
    canonical: intent.canonical,
    params: normalizeJsonValue(intent.params),
  };
}

/** Internal function that computes the hash string from an already-normalized Intent (does not re-normalize). */
async function hashNormalized(normalized: IntentInput): Promise<string> {
  const hex = await sha256Hex(
    canonicalStringify({ canonical: normalized.canonical, params: normalized.params }),
  );
  return `sha256:${hex}`;
}

export async function computeIntentHash(intent: IntentInput): Promise<string> {
  return hashNormalized(normalizeIntent(intent));
}

/**
 * True when the value already carries a validly-formed hash (i.e. is a genuine CanonicalIntent, not just
 * an IntentInput). Validates the `sha256:<64 hex>` shape via IntentHashSchema rather than merely checking
 * `typeof hash === "string"` — a bare string check would also match a test double or half-built object
 * that happens to carry an empty or placeholder `hash` field, silently skipping real hash computation and
 * shipping an invalid intentHash downstream.
 */
function hasHash(intent: IntentInput): intent is IntentInput & Pick<CanonicalIntent, "hash"> {
  return IntentHashSchema.safeParse((intent as Partial<CanonicalIntent>).hash).success;
}

/**
 * Returns a CanonicalIntent that is normalized with its hash filled in (normalization runs exactly once).
 *
 * When `intent` already carries a `hash` (i.e. it is itself a CanonicalIntent — a caller re-finalizing an
 * already-finalized Intent unchanged), the hash computation is skipped and the value is returned as-is:
 * a CanonicalIntent's params are already canonical-order-normalized from the call that produced it, so
 * recomputing sha256 over the identical bytes would be pure waste. The exported signature is unchanged
 * (IntentInput -> Promise<CanonicalIntent>) since CanonicalIntent is structurally an IntentInput plus
 * `hash`, so existing callers passing a plain IntentInput are unaffected.
 */
export async function finalizeIntent(intent: IntentInput): Promise<CanonicalIntent> {
  if (hasHash(intent)) return intent as CanonicalIntent;
  const normalized = normalizeIntent(intent);
  return {
    ...normalized,
    hash: await hashNormalized(normalized),
  };
}
