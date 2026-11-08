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
