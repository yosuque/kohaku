import {
  type CanonicalIntent,
  computeStructureHash,
  type FixationRecord,
  FixationRecordSchema,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { ComposeResult } from "./compose.js";
import type { ComposeContext } from "./context.js";
import { resolveHandleVersions } from "./refs.js";
import type { ComposeTrace } from "./trace.js";

/**
 * Result of the staleness check when delivering a fixation (L0).
 * - fresh: the catalog fingerprint at fixation time matches the current one → deliver as-is, skipping revalidation.
 * - revalidated: the fingerprint mismatches/is missing, but revalidation against the current catalog passes → deliverable (the host re-stamps the fingerprint).
 * - stale: validation against the current catalog fails → not deliverable (the host invalidates the fixation and falls back to normal compose).
 */
export type FixationCheck = { kind: "fresh" } | { kind: "revalidated" } | { kind: "stale"; issues: string[] };

/**
 * Builds the Spec / trace on a fixation (L1→L0) hit.
 *
 * provenance.cache="fixated" / trace.cache="fixated" / cacheKey / tier="L0" is the norm for
 * "cross-surface identical display" (spec/SPEC.md). Writing it per host would silently break when one
 * side changes, so it is consolidated in the composer to guarantee identical materialization across all surfaces.
 *
 * Staleness detection: because pinnedSpec is the structure at fixation time, if the catalog
 * (component types/props) subsequently changes it would keep delivering a broken structure. The return
 * value's check hands the host the material to decide:
 * - fresh / revalidated: return with a Spec in result (deliverable).
 * - stale: return with result=null (not deliverable — the host falls back to normal compose).
 * lineage recording (intent.unfixated on invalidate, etc.) is not done in the composer
 * (the dependency direction must not flow backward — recording is the host layer's responsibility).
 */
export async function materializeFixation(
  fixation: FixationRecord,
  intent: CanonicalIntent,
  ctx: ComposeContext,
  tenant?: string,
): Promise<{ result: ComposeResult | null; check: FixationCheck }> {
  // Storage-boundary validation: a corrupted or hand-edited fixation record
  // (most importantly a broken pinnedSpec) must never be delivered just because it happens to carry a
  // matching catalog fingerprint — the fingerprint fast path below only ever compared a *string*, so it
  // cannot itself catch a structurally broken pinnedSpec. Treated as "not deliverable" (the host's
  // self-healing then rediscovers the same corruption independently the next time it reads this record
  // through lineage's own FixationRecordSchema-validated getter).
  const validated = FixationRecordSchema.safeParse(fixation);
  if (!validated.success) {
    return {
      result: null,
      check: {
        kind: "stale",
        issues: [`fixation record failed schema validation: ${validated.error.message}`],
      },
    };
  }
  fixation = validated.data as FixationRecord;

  // Deeper corruption than FixationRecordSchema alone can catch: a hand-edited record whose declared
  // intentHash / structureHash no longer matches its own pinnedSpec would otherwise sail through the
  // schema check above (both fields are just strings, structurally valid on their own) and could be
  // delivered for the wrong Intent, or with a pinnedSpec that was edited without recomputing its
  // structureHash (a broken fixation-stability tally, and — if the edit changed refs/components — the
  // same "structure changed underneath the record" risk the fingerprint/catalog checks below exist to
  // catch). Treat either mismatch as corruption, exactly like a schema-validation failure.
  if (fixation.intentHash !== intent.hash) {
    return {
      result: null,
      check: {
        kind: "stale",
        issues: [
          `fixation record's intentHash (${fixation.intentHash}) does not match the requested intent (${intent.hash})`,
        ],
      },
    };
  }
  const actualStructureHash = await computeStructureHash(fixation.pinnedSpec);
  if (actualStructureHash !== fixation.structureHash) {
    return {
      result: null,
      check: {
        kind: "stale",
        issues: [
          `fixation record's structureHash (${fixation.structureHash}) does not match its pinnedSpec (${actualStructureHash})`,
        ],
      },
    };
  }

  // Fingerprint fast path: if the catalog fingerprint at fixation time matches the current one, treat the structure as unchanged and skip validation.
  // Only on mismatch/absence (an old record) is pinnedSpec revalidated against the current catalog.
  let check: FixationCheck;
  if (fixation.catalogFingerprint === ctx.catalog.fingerprint) {
    check = { kind: "fresh" };
  } else {
    const { issues } = ctx.catalog.validate(fixation.pinnedSpec.components, fixation.pinnedSpec.events);
    if (issues.length > 0) {
      // Validation failure = not deliverable. Format issues into human-readable strings and hand them to the host.
      return {
        result: null,
        check: { kind: "stale", issues: issues.map((i) => `${i.componentId}: ${i.message}`) },
      };
    }
    check = { kind: "revalidated" };
  }

  const { handles, dataVersion, versionsByRef } = await resolveHandleVersions(intent, ctx, tenant);

  // Reinforcement of staleness detection (multi-ref): confirm that the fixed Spec matches the
  // current Intent's "resolved URI set". Because catalogFingerprint derives from the catalog (component
  // types/props) and is independent of the query mapping, even with the same intent, if a code revision
  // or a semantic-layer change makes the resolved URI set drift (add/remove/swap), neither the
  // fingerprint fast path (fresh) nor revalidation (revalidated) can catch it. Delivering with the
  // mismatch, refVersions is filled with the current URIs while the pinned structure corresponds to the
  // old set, so per-reference matching breaks (a removed ref never appears among the match targets and
  // always displays STALE; an added ref is delivered fresh without a corresponding component). Err on the
  // safe side by treating it as stale and falling back to normal compose. The direction
  // (added/removed/orphan) is also placed on stale for auditing.
  const resolvedUris = new Set(handles.map((h) => h.uri));
  const drift = detectRefDrift(fixation, resolvedUris);
  if (drift != null) {
    return {
      result: null,
      check: {
        kind: "stale",
        issues: [
          `The fixed Spec's reference set does not match the current Intent's resolution result (${drift.kind}: ${drift.uri})`,
        ],
      },
    };
  }

  // pinnedSpec's refVersions is the old version at fixation time, so always drop it and re-fill with the latest version.
  // Delivering it as-is would make the renderer's per-reference matching always STALE.
  const { refVersions: _stale, ...pinnedRest } = fixation.pinnedSpec;
  const spec: UISpec = {
    ...pinnedRest,
    intent,
    dataVersion,
    ...(handles.length > 0 ? { refVersions: versionsByRef } : {}),
    provenance: { ...fixation.pinnedSpec.provenance, tier: "L0", cache: "fixated" },
  };
  const trace: ComposeTrace = {
    input: { kind: "intent" },
    intent,
    refs: handles.map((h) => h.uri),
    dataVersion: spec.dataVersion,
    cacheKey: `fixated:${intent.hash}`,
    // Distinguish a fixation short-circuit from a normal cache hit (consistent with provenance.cache="fixated").
    cache: "fixated",
    tier: "L0",
    attempts: [],
    durationMs: 0,
  };
  return { result: { spec, trace }, check };
}

/**
 * One drift item of the resolved URI set. kind is direction information for the audit detail:
 * - added: a URI that increased in the current resolved set (was not present at fixation time)
 * - removed: a URI that was present at fixation time but disappeared from the current resolved set
 * - orphan: for an old record (refVersions missing), a pinned component's $ref is not contained in the current resolved set
 */
type RefDrift = { uri: string; kind: "added" | "removed" | "orphan" };

/**
 * Checks whether the fixed Spec's reference set has drifted from the current Intent's resolved URI set,
 * and returns one drift item (with direction). Returns null if there is no drift. The detection
 * conditions and the way of erring toward stale are made to match the norms of spec/SPEC.md §8 /
 * docs/specification.md §5.4 (here we only add direction information for the audit; behavior is unchanged).
 * - with refVersions: because compose fills refVersions with "all resolved URIs", that key set is the
 *   resolved URI set at fixation time. Take the bidirectional difference from the current set and return
 *   added preferentially (one direction would miss an add drift such as 1→2 refs).
 * - refVersions missing (an old record): the resolved set at fixation time is unknown. Confirm at least,
 *   in one direction, that the pinned components' $ref are covered by the current resolved URIs (best-effort / orphan).
 */
function detectRefDrift(fixation: FixationRecord, resolvedUris: Set<string>): RefDrift | null {
  const pinnedRefVersions = fixation.pinnedSpec.refVersions;
  if (pinnedRefVersions != null) {
    const added = [...resolvedUris].find((uri) => !(uri in pinnedRefVersions));
    if (added != null) return { uri: added, kind: "added" };
    const removed = Object.keys(pinnedRefVersions).find((uri) => !resolvedUris.has(uri));
    if (removed != null) return { uri: removed, kind: "removed" };
    return null;
  }
  const orphan = fixation.pinnedSpec.components
    .flatMap((c) => (c.data != null ? [c.data.$ref] : []))
    .find((ref) => !resolvedUris.has(ref));
  return orphan != null ? { uri: orphan, kind: "orphan" } : null;
}
