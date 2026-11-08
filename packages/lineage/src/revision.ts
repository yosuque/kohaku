/**
 * Generates a coarse ulid-like, per-write revision token: a base36 ms timestamp plus a random suffix. Not the
 * full `ulid` library (no cross-service sortability guarantee is needed here) -- only "distinguishable from the
 * previous write even inside the same millisecond" matters, which a timestamp such as `fixatedAt` (an
 * ms-precision ISO string) cannot provide (an unfixate -> fixate pair landing in the same ms would otherwise
 * share a TOCTOU guard token with the fixation it replaced).
 *
 * Shared by the fixation service (`FixationRecord.revision`) and the promotion candidate store
 * (`PromotionState.revision`): both are the tokens a `StoragePort` that declares `supportsCompareAndSet`
 * compares on a conditional write.
 */
export function generateRevision(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The `expectedRevision` token for a stored record's `revision` on a compare-and-set port: the revision itself,
 * or `""` ("the record exists but carries no revision") for a record that predates the field. The empty string
 * is the wire value `StoragePort` gives that state, so a legacy record is guarded by a compare-and-set write
 * exactly like a versioned one instead of being written unconditionally. (An absent record is `null`, which
 * callers decide before they get here.)
 */
export function revisionToken(revision: unknown): string {
  return typeof revision === "string" ? revision : "";
}
