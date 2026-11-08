import {
  type CanonicalIntent,
  computeStructureHash,
  type FilterDescriptor,
  type FixationRecord,
  FixationRecordSchema,
  parseQueryRef,
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
 * - unavailable: the check itself could not run (the filter descriptor source threw for a pin that carries
 *   `data.bind`) → not deliverable THIS time, but the fixation is NOT invalidated: it may well be fine, and the
 *   pinned binds must not be signed unchecked. The host falls back to normal compose for this request and
 *   reports `cause`.
 */
export type FixationCheck =
  | { kind: "fresh" }
  | { kind: "revalidated" }
  | { kind: "stale"; issues: string[] }
  | { kind: "unavailable"; issues: string[]; cause?: unknown };

/** materializeFixation's return shape: the composed result when deliverable (null when not), plus the staleness verdict. */
export type FixationMaterialization = { result: ComposeResult | null; check: FixationCheck };

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
 * A pinned L1 Spec carrying injected filters (`data.bind`, `ComposePolicy.l1Filters`) is also checked against the
 * CURRENT filter descriptors (`SemanticPort.describeFilters`, when the port has it): see detectFilterDrift.
 * lineage recording (intent.unfixated on invalidate, etc.) is not done in the composer
 * (the dependency direction must not flow backward — recording is the host layer's responsibility).
 */
export async function materializeFixation(
  fixation: FixationRecord,
  intent: CanonicalIntent,
  ctx: ComposeContext,
  tenant?: string,
): Promise<FixationMaterialization> {
  // Shared shape for every "not deliverable" exit below: result=null plus the stale verdict with its
  // issues (the host's material for falling back to normal compose and, where wired, for lineage recording).
  const stale = (issues: string[]): FixationMaterialization => ({
    result: null,
    check: { kind: "stale", issues },
  });

  // Storage-boundary validation: a corrupted or hand-edited fixation record
  // (most importantly a broken pinnedSpec) must never be delivered just because it happens to carry a
  // matching catalog fingerprint — the fingerprint fast path below only ever compared a *string*, so it
  // cannot itself catch a structurally broken pinnedSpec. Treated as "not deliverable" (the host's
  // self-healing then rediscovers the same corruption independently the next time it reads this record
  // through lineage's own FixationRecordSchema-validated getter).
  const validated = FixationRecordSchema.safeParse(fixation);
  if (!validated.success) {
    return stale([`fixation record failed schema validation: ${validated.error.message}`]);
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
    return stale([
      `fixation record's intentHash (${fixation.intentHash}) does not match the requested intent (${intent.hash})`,
    ]);
  }
  const actualStructureHash = await computeStructureHash(fixation.pinnedSpec);
  if (actualStructureHash !== fixation.structureHash) {
    return stale([
      `fixation record's structureHash (${fixation.structureHash}) does not match its pinnedSpec (${actualStructureHash})`,
    ]);
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
      return stale(issues.map((i) => `${i.componentId}: ${i.message}`));
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
    return stale([
      `The fixed Spec's reference set does not match the current Intent's resolution result (${drift.kind}: ${drift.uri})`,
    ]);
  }

  // Authorized-range drift of injected filters (design.md #78): the pinned Spec's `data.bind` values are the
  // read scopes the capability issued for it is built from, and nothing above looks at them. A bind value the
  // Intent's CURRENT descriptors no longer offer (an option removed from a vocabulary, a facet made
  // `filterable: false`, a tenant's narrowed list) must not keep minting capabilities from a pin.
  const filterCheck = await detectFilterDrift(fixation.pinnedSpec, intent, ctx, tenant);
  if (filterCheck?.kind === "drift") return stale([`filter options drifted: ${filterCheck.detail}`]);
  if (filterCheck?.kind === "unavailable") {
    return {
      result: null,
      check: {
        kind: "unavailable",
        issues: ["filter descriptors unavailable: the pinned data.bind values could not be checked"],
        cause: filterCheck.cause,
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
    // A fixation delivery never ran prepareCompose's cache-key computation (it short-circuits before it),
    // so there is no real generatorVersion/policyFingerprint to report here -- intentHash/dataVersion are
    // the only components that are actually meaningful for a fixated trace.
    cacheKeyParts: { intentHash: intent.hash, dataVersion: spec.dataVersion },
    // Distinguish a fixation short-circuit from a normal cache hit (consistent with provenance.cache="fixated").
    cache: "fixated",
    tier: "L0",
    attempts: [],
    durationMs: 0,
  };
  return { result: { spec, trace }, check };
}

/**
 * Checks that every `data.bind` of a pinned L1 Spec is still allowed by the Intent's CURRENT filter
 * descriptors: `drift` (with a human-readable description of the first violation), `unavailable` (the
 * descriptor source threw), or null (no violation, or nothing to check).
 *
 * Only L1 pins are checked (`provenance.tier === "L1"`): fixation pins an L1-generated Spec, the model cannot
 * author `data.bind`, and the only source of one on L1 is the composer's own injection from a descriptor (or a
 * product `extraRules` post rule, which is then subject to this check too). An L0 pin's binds are the
 * template's own hand-written cross-filter (the template owns their drift; out of scope here), so an approved
 * L0 fixation carrying them must not go stale just because the Intent exposes no descriptor for them.
 *
 * Inside L1, each bind must still be governed by a descriptor -- the same `queryParam`, whose `paths` include
 * the carrying component's ref path -- and its `values` must be a SUBSET of that descriptor's option values.
 * Compared by subset of values, not by hash: a label-only change, or options added to the vocabulary, leave the
 * pin deliverable. A bind with no governing descriptor at all (the filter was removed) is drift too.
 *
 * Without a descriptor source -- a SemanticPort with no `describeFilters` -- nothing is checked (documented,
 * today's behaviour). A source that THROWS is a different case: failing open would sign the pinned binds
 * unchecked, so the result is `unavailable` (fail closed for this request, without destroying the fixation).
 * A Spec with no `data.bind` never calls the port. The descriptors are the port's own: the composer's shape
 * guard (dropShapeChangingFilters) is not re-run on this delivery fast path.
 */
async function detectFilterDrift(
  pinned: UISpec,
  intent: CanonicalIntent,
  ctx: ComposeContext,
  tenant?: string,
): Promise<{ kind: "drift"; detail: string } | { kind: "unavailable"; cause: unknown } | null> {
  if (pinned.provenance.tier !== "L1") return null;
  const bound = pinned.components.filter((c) => c.data?.bind != null && Object.keys(c.data.bind).length > 0);
  if (bound.length === 0 || ctx.semantic.describeFilters == null) return null;
  let descriptors: FilterDescriptor[];
  try {
    descriptors = await ctx.semantic.describeFilters(intent, tenant != null ? { tenant } : undefined);
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
  for (const c of bound) {
    let path: string;
    try {
      path = parseQueryRef(c.data!.$ref).path;
    } catch {
      continue; // an unparsable ref is the ref-drift check's business, not a filter's
    }
    for (const [queryParam, bind] of Object.entries(c.data!.bind!)) {
      const governing = descriptors.find(
        (d) => d.queryParam === queryParam && Array.isArray(d.paths) && d.paths.includes(path),
      );
      if (governing == null) {
        return { kind: "drift", detail: `${c.id}: no filter governs "${queryParam}" on "${path}" any more` };
      }
      const allowed = new Set(governing.options.map((o) => o.value));
      const removed = bind.values.find((v) => !allowed.has(v));
      if (removed != null) {
        return {
          kind: "drift",
          detail: `${c.id}: "${queryParam}" value "${removed}" is no longer an option`,
        };
      }
    }
  }
  return null;
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
