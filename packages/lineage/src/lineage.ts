import {
  computeSpecHash,
  computeStructureHash,
  type JsonObject,
  type LineageEventRecord,
  type LineageFilter,
  type StoragePort,
  type Surface,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { ulid } from "ulid";
import {
  type ActorKind,
  COMPONENT_EVENT_TYPES,
  type ComponentUsedPayload,
  type LineageEventType,
  makeEvent,
  type ViewComposedPayload,
} from "./events.js";
import { tenantField } from "./tenant-scope.js";

export interface ComposeTraceLike {
  intent: { canonical: string; hash: string };
  dataVersion: string;
  cache: string;
  tier: "L0" | "L1" | "L2";
  model?: string;
  durationMs: number;
}

export interface Lineage {
  /**
   * Appends an arbitrary event (higher-level APIs such as the promotion pipeline use this too).
   * Passing tenant stamps it into LineageEventRecord.tenant (only when non-null).
   */
  record(
    type: LineageEventType,
    payload: Record<string, unknown>,
    actor?: ActorKind,
    tenant?: string,
  ): Promise<LineageEventRecord>;

  viewComposed(args: {
    spec: UISpec;
    trace: ComposeTraceLike;
    surface: Surface;
    sessionId?: string;
    /** Tenant scoping stamped into the recorded events (view.composed / component.generated / component.used). */
    tenant?: string;
    /**
     * Precomputed hash. If already computed within a single request, pass it to skip re-hashing the Spec
     * (the stream path computes specHash for the done event, so sharing it means computing only once).
     * If unset, computeSpecHash / computeStructureHash run internally (the default, backward-compatible path).
     */
    specHash?: string;
    structureHash?: string;
  }): Promise<void>;
  viewRendered(args: {
    specHash: string;
    surface: Surface;
    renderer: string;
    durationMs?: number;
    tenant?: string;
  }): Promise<void>;
  viewInteracted(args: {
    intentHash: string;
    componentId: string;
    on: string;
    payload: JsonObject;
    surface: Surface;
    sessionId?: string;
    tenant?: string;
  }): Promise<void>;
  viewFallback(args: {
    specHash: string;
    reason: string;
    surface: Surface;
    /** Kind of downgrade. When omitted, not stamped into the payload */
    kind?: "generation" | "negotiation";
    /** So the audit can trace "which intent's view was downgraded" */
    intentHash?: string;
    sessionId?: string;
    tenant?: string;
  }): Promise<void>;
  componentUsed(args: ComponentUsedPayload & { tenant?: string }): Promise<void>;

  /** Audit query for "why was this view shown" */
  explainView(specHash: string): Promise<LineageEventRecord[]>;
  /** A component's provenance (generation -> use -> promotion) */
  history(artifactId: string): Promise<LineageEventRecord[]>;
  list(filter?: LineageFilter): Promise<LineageEventRecord[]>;
}

export function artifactIdOf(sha256: string): string {
  return `art-${sha256.slice(0, 12)}`;
}

export function createLineage(opts: { storage: StoragePort; newId?: () => string }): Lineage {
  const newId = opts.newId ?? ulid;

  // In-process cache to skip the component.generated duplicate check.
  // Avoids the N+1 of a full listLineage scan (a linear array scan in the sample implementation) per L2 component on the compose hot path.
  // Remembers, keyed by (tenant, artifactId), that "this recorder already recorded generated / confirmed existence in storage".
  // Because component.generated is recorded per tenant at first sighting, both the dedup lookup and the known set are
  // split per tenant (artifactId is globally unique since it derives from the content sha256, but whether it was recorded differs per tenant).
  // The key is a NUL-separated composite (tenant\u0000artifactId; an unset tenant is the empty string).
  // On process restart it starts from an empty set; unknown keys fall back to a storage lookup, which keeps a cold cache correct.
  // This Set has no eviction and grows monotonically in proportion to the number of distinct (tenant, artifactId) pairs. Like the
  // unbounded growth of lineage.jsonl (see the storage-port lead doc), it is a known constraint that can pressure memory in
  // long-running operation (production is expected to swap in a dedicated event store / DB, so no eviction is added here).
  const knownGeneratedIds = new Set<string>();

  const record: Lineage["record"] = async (type, payload, actor, tenant) => {
    const event = makeEvent(newId(), type, payload, actor, tenant);
    await opts.storage.appendLineage(event);
    return event;
  };

  return {
    record,

    async viewComposed({
      spec,
      trace,
      surface,
      sessionId,
      tenant,
      specHash: precomputedSpecHash,
      structureHash: precomputedStructureHash,
    }) {
      // If a precomputed hash is available, do not recompute (avoids duplicating canonicalStringify+sha256 of the same Spec).
      const specHash = precomputedSpecHash ?? (await computeSpecHash(spec));
      const structureHash = precomputedStructureHash ?? (await computeStructureHash(spec));
      // The composer emits at most one L2 sandbox node per Spec (spec-core's validateSpecStructure warns
      // with MULTIPLE_SANDBOX_NODES if that invariant is ever broken), so picking the first is exhaustive.
      const sandboxNode = spec.components.find((c) => c.artifact != null);
      const artifactId =
        sandboxNode?.artifact != null ? artifactIdOf(sandboxNode.artifact.sha256) : undefined;

      const payload: ViewComposedPayload & { structureHash: string; params: JsonObject } = {
        specHash,
        structureHash,
        intentHash: spec.intent.hash,
        canonical: spec.intent.canonical,
        params: spec.intent.params,
        dataVersion: spec.dataVersion,
        tier: spec.provenance.tier,
        cache: spec.provenance.cache,
        surface,
        ...(sessionId != null ? { sessionId } : {}),
        ...(spec.provenance.model != null ? { model: spec.provenance.model } : {}),
        durationMs: trace.durationMs,
        ...(artifactId != null ? { artifactId } : {}),
      };
      await record(
        "view.composed",
        payload as unknown as Record<string, unknown>,
        {
          kind: spec.provenance.tier === "L0" ? "system" : "model",
          ...(spec.provenance.model != null ? { model: spec.provenance.model } : {}),
        },
        tenant,
      );

      // Component Lineage for the L2 component: automatically record the first generation and use (the input source for promotion)
      if (sandboxNode?.artifact != null && artifactId != null) {
        // component.generated is recorded per tenant at first sighting. The Spec cache is tenant-neutral
        // (the cache key has no tenant component), so the second and later tenants may receive the same Spec as cache:hit.
        // Restricting to miss/bypass would mean generated is never recorded for a cache:hit tenant and it never appears as a
        // promotion candidate, so regardless of cache we "record if it was not recorded for this tenant" (since the spec carries
        // the artifact inline, there is material to record even on cache:hit).
        const knownKey = `${tenant ?? ""}\u0000${artifactId}`;
        // If known ((tenant, artifactId) already recorded / confirmed), skip the storage lookup (the per-tenant dedup cache above).
        // To keep concurrent composes from double-recording component.generated by interleaving at the "confirm existence -> record"
        // await boundary, reserve into the known set **before** the existence check (closes the check-then-act window). If the
        // existence check / record fails, roll back the reservation (prevents making the known status permanent = fixating a missed
        // record, so the next compose can retry).
        if (!knownGeneratedIds.has(knownKey)) {
          knownGeneratedIds.add(knownKey);
          try {
            const existing = await opts.storage.listLineage({
              type: ["component.generated"],
              artifactId,
              limit: 1,
              ...tenantField(tenant),
            });
            if (existing.length === 0) {
              await record(
                "component.generated",
                {
                  artifactId,
                  artifactSha256: sandboxNode.artifact.sha256,
                  intentHash: spec.intent.hash,
                  canonical: spec.intent.canonical,
                  specHash,
                  // Keep the artifact body too, since it is needed for the promotion review (preview / publish)
                  // (JSONL is sufficient at demo scale; production is expected to use a dedicated artifact store)
                  ...(sandboxNode.artifact.inline != null ? { html: sandboxNode.artifact.inline } : {}),
                  // The data reference at generation time. Used so the promotion review preview can re-mount with the same data
                  // (the sandbox bridge's allowlist requires an exact match with data.$ref, so without this the data cannot be resolved).
                  ...(sandboxNode.data?.$ref != null ? { ref: sandboxNode.data.$ref } : {}),
                  ...(spec.provenance.model != null ? { model: spec.provenance.model } : {}),
                  ...(typeof spec.intent.params["request"] === "string"
                    ? { request: spec.intent.params["request"] }
                    : {}),
                },
                {
                  kind: "model",
                  ...(spec.provenance.model != null ? { model: spec.provenance.model } : {}),
                },
                tenant,
              );
            }
          } catch (e) {
            knownGeneratedIds.delete(knownKey);
            throw e;
          }
        }
        await record(
          "component.used",
          {
            artifactId,
            intentHash: spec.intent.hash,
            surface,
            ...(sessionId != null ? { sessionId } : {}),
            outcome: "ok",
          },
          undefined,
          tenant,
        );
      }
    },

    async viewRendered({ tenant, ...args }) {
      await record("view.rendered", { ...args }, undefined, tenant);
    },

    async viewInteracted({ tenant, ...args }) {
      await record("view.interacted", { ...args }, { kind: "user" }, tenant);
    },

    async viewFallback(args) {
      // Unspecified optionals (kind / intentHash / sessionId) are not stamped into the payload (no undefined keys left behind).
      // The tenant is stamped into the record's tenant field, not into the payload.
      await record(
        "view.fallback",
        {
          specHash: args.specHash,
          reason: args.reason,
          surface: args.surface,
          ...(args.kind != null ? { kind: args.kind } : {}),
          ...(args.intentHash != null ? { intentHash: args.intentHash } : {}),
          ...(args.sessionId != null ? { sessionId: args.sessionId } : {}),
        },
        undefined,
        args.tenant,
      );
    },

    async componentUsed({ tenant, ...args }) {
      await record("component.used", { ...args }, undefined, tenant);
    },

    async explainView(specHash) {
      return opts.storage.listLineage({ specHash });
    },

    async history(artifactId) {
      return opts.storage.listLineage({
        artifactId,
        type: [...COMPONENT_EVENT_TYPES],
      });
    },

    async list(filter) {
      return opts.storage.listLineage(filter);
    },
  };
}
