import {
  type CacheKeyParts,
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
  type ActionApprovalRequestedPayload,
  type ActionApprovedPayload,
  type ActionDeniedPayload,
  type ActionInvokedPayload,
  type ActorKind,
  COMPONENT_EVENT_TYPES,
  type ComponentUsedPayload,
  type LineageEventType,
  makeEvent,
  type PolicyAppliedPayload,
  type ViewComposedDecision,
  type ViewComposedPayload,
  type ViewDecisionAttempt,
  type ViewDecisionDowngrade,
} from "./events.js";
import { tenantField } from "./tenant-scope.js";

/**
 * The subset of @kohaku-ui/composer's ComposeTrace that viewComposed needs. A structural duck type rather
 * than an import of ComposeTrace itself: lineage does not depend on composer (see AGENTS.md's dependency
 * direction -- composer sits below lineage in the layer graph, but the package.json edge was never added,
 * and this decoupling lets any caller build its own trace-shaped object without a hard dependency).
 *
 * correlationId / cacheKey / cacheKeyParts / attempts / downgrades / coalesced / usage are all optional
 * additions: a caller that builds a ComposeTraceLike without them (or a pre-existing test fixture) gets
 * the exact same view.composed / component.generated / component.used payload shape as before they existed
 * -- see viewComposed's payload construction, which omits each corresponding key when its trace field is
 * unset.
 */
export interface ComposeTraceLike {
  intent: { canonical: string; hash: string };
  dataVersion: string;
  cache: string;
  tier: "L0" | "L1" | "L2";
  model?: string;
  durationMs: number;
  correlationId?: string;
  cacheKey?: string;
  cacheKeyParts?: CacheKeyParts;
  attempts?: ViewDecisionAttempt[];
  downgrades?: ViewDecisionDowngrade[];
  coalesced?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

const MAX_DECISION_ISSUES = 5;
const MAX_DECISION_ISSUE_LENGTH = 200;

/** Caps an attempt's issues to at most MAX_DECISION_ISSUES entries of at most MAX_DECISION_ISSUE_LENGTH
 * characters each (an ellipsis marks a truncated string), so a verbose validation-error trail cannot bloat
 * the lineage record without bound. Returns undefined for an empty/unset list (keeps `issues` off the
 * payload rather than recording `issues: []`). */
function truncateIssues(issues: string[] | undefined): string[] | undefined {
  if (issues == null || issues.length === 0) return undefined;
  return issues
    .slice(0, MAX_DECISION_ISSUES)
    .map((issue) =>
      issue.length > MAX_DECISION_ISSUE_LENGTH ? `${issue.slice(0, MAX_DECISION_ISSUE_LENGTH)}…` : issue,
    );
}

/**
 * The fixed, non-sensitive message persisted for a thrown-exception attempt, keyed by its `errorCode` (see
 * ViewDecisionAttempt's doc comment). Deliberately generic and static -- never derived from the exception
 * itself -- because a provider/network error's own `.message` can carry a hostname, URL, or account details
 * a `lineage.read` principal (via `/lineage`, `kohaku explain`, or DevTools) has no business seeing.
 */
const THROWN_ATTEMPT_MESSAGE: Record<NonNullable<ViewDecisionAttempt["errorCode"]>, string> = {
  CONFIG: "The LLM provider was misconfigured.",
  INVALID_OUTPUT: "The LLM's output could not be parsed.",
  PROVIDER: "The LLM provider call failed.",
  ABORTED: "Generation was aborted.",
  UNKNOWN: "An unexpected error occurred during generation.",
};

/** Builds view.composed's `decision` summary from the trace, or undefined when there is nothing to
 * summarize (no attempts, no downgrades, not coalesced, no usage) -- the common case for a cache hit / L0
 * fixed Spec, which should not grow a `decision` key at all. */
function buildDecision(trace: ComposeTraceLike): ViewComposedDecision | undefined {
  const attempts = trace.attempts ?? [];
  const downgrades = trace.downgrades ?? [];
  if (attempts.length === 0 && downgrades.length === 0 && trace.coalesced !== true && trace.usage == null) {
    return undefined;
  }
  return {
    attempts: attempts.map((a) => {
      // A thrown-exception attempt (errorCode set) never has its own issues[] (the exception's raw message,
      // needed only for the repair loop's in-process feedback/visibility) persisted here -- only the fixed,
      // non-sensitive message for its errorCode. A validation-failed attempt (errorCode unset) keeps its
      // actual issue strings, still truncated.
      const issues = a.errorCode != null ? [THROWN_ATTEMPT_MESSAGE[a.errorCode]] : truncateIssues(a.issues);
      return {
        kind: a.kind,
        ok: a.ok,
        ...(issues != null ? { issues } : {}),
        ...(a.errorCode != null ? { errorCode: a.errorCode } : {}),
      };
    }),
    ...(downgrades.length > 0 ? { downgrades } : {}),
    ...(trace.coalesced === true ? { coalesced: true as const } : {}),
    ...(trace.usage != null ? { usage: trace.usage } : {}),
  };
}

/** The `model` payload / actor field, omitted entirely when the Spec carries no model (no undefined key). */
function modelField(spec: UISpec): { model: string } | Record<string, never> {
  return spec.provenance.model != null ? { model: spec.provenance.model } : {};
}

/** The actor stamped on view.composed / component.generated: `kind`, plus the generating model when known. */
function actorOf(spec: UISpec, kind: "system" | "model"): { kind: "system" | "model"; model?: string } {
  return { kind, ...modelField(spec) };
}

/** Builds the `view.composed` payload (omitting each optional key when its source is unset; key order is part of the recorded shape). */
function buildViewComposedPayload(args: {
  spec: UISpec;
  trace: ComposeTraceLike;
  surface: Surface;
  sessionId: string | undefined;
  specHash: string;
  structureHash: string;
  artifactId: string | undefined;
}): ViewComposedPayload & { structureHash: string; params: JsonObject } {
  const { spec, trace, surface, sessionId, specHash, structureHash, artifactId } = args;
  const decision = buildDecision(trace);
  return {
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
    ...modelField(spec),
    durationMs: trace.durationMs,
    ...(artifactId != null ? { artifactId } : {}),
    ...(trace.correlationId != null ? { correlationId: trace.correlationId } : {}),
    ...(trace.cacheKey != null ? { cacheKey: trace.cacheKey } : {}),
    ...(trace.cacheKeyParts != null ? { cacheKeyParts: trace.cacheKeyParts } : {}),
    ...(spec.provenance.generatorVersion != null
      ? { generatorVersion: spec.provenance.generatorVersion }
      : {}),
    ...(spec.provenance.kit != null ? { kit: spec.provenance.kit } : {}),
    ...(spec.provenance.fallback != null ? { fallback: spec.provenance.fallback } : {}),
    ...(decision != null ? { decision } : {}),
  };
}

/** The artifact inline-or-referenced by an L2 sandbox node (the node `viewComposed` selects by `artifact != null`). */
type SandboxArtifact = NonNullable<UISpec["components"][number]["artifact"]>;

/** Builds the `component.generated` payload for an L2 sandbox node's artifact (key order is part of the recorded shape). */
function buildComponentGeneratedPayload(args: {
  spec: UISpec;
  trace: ComposeTraceLike;
  artifactId: string;
  artifact: SandboxArtifact;
  ref: string | undefined;
  specHash: string;
}): Record<string, unknown> {
  const { spec, trace, artifactId, artifact, ref, specHash } = args;
  return {
    artifactId,
    artifactSha256: artifact.sha256,
    intentHash: spec.intent.hash,
    canonical: spec.intent.canonical,
    specHash,
    // Keep the artifact body too, since it is needed for the promotion review (preview / publish)
    // (JSONL is sufficient at demo scale; production is expected to use a dedicated artifact store)
    ...(artifact.inline != null ? { html: artifact.inline } : {}),
    // The data reference at generation time. Used so the promotion review preview can re-mount with the same data
    // (the sandbox bridge's allowlist requires an exact match with data.$ref, so without this the data cannot be resolved).
    ...(ref != null ? { ref } : {}),
    ...modelField(spec),
    ...(typeof spec.intent.params["request"] === "string" ? { request: spec.intent.params["request"] } : {}),
    ...(trace.correlationId != null ? { correlationId: trace.correlationId } : {}),
    ...(spec.provenance.kit != null ? { kit: spec.provenance.kit } : {}),
    ...(spec.provenance.generatorVersion != null
      ? { generatorVersion: spec.provenance.generatorVersion }
      : {}),
  };
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
    /** The compose trace's correlation id (see ViewComposedPayload.correlationId's doc comment). */
    correlationId?: string;
  }): Promise<void>;
  componentUsed(args: ComponentUsedPayload & { tenant?: string }): Promise<void>;

  /**
   * Records a `policy.applied` audit event (design.md #69). The caller (host-core's
   * `PolicyRuntime`'s `audit` callback) is responsible for the dedup rule ("a byte-identical reload is
   * not audit-worthy") -- this method unconditionally records whatever event it is given.
   */
  policyApplied(event: PolicyAppliedPayload, actor?: ActorKind, tenant?: string): Promise<void>;

  /**
   * Records `action.invoked` (design.md #62/#63) -- the ActionGate returned `allow`. Recorded before
   * `DomainPort.invoke` runs, so it does not imply the write succeeded.
   */
  actionInvoked(event: ActionInvokedPayload, actor?: ActorKind, tenant?: string): Promise<void>;
  /** Records `action.denied` (design.md #63) -- a presented approval token did not verify. */
  actionDenied(event: ActionDeniedPayload, actor?: ActorKind, tenant?: string): Promise<void>;
  /**
   * Records `action.approvalRequested` (design.md #63) -- nothing was presented yet. The caller
   * (`createActionAuditRecorder`) is responsible for whether `event.payload` is populated (its own
   * `recordPayload` option); this method records unconditionally whatever it is given.
   */
  actionApprovalRequested(
    event: ActionApprovalRequestedPayload,
    actor?: ActorKind,
    tenant?: string,
  ): Promise<void>;
  /** Records `action.approved` (design.md #63) -- a presented approval grant was successfully consumed. */
  actionApproved(event: ActionApprovedPayload, actor?: ActorKind, tenant?: string): Promise<void>;

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

      const payload = buildViewComposedPayload({
        spec,
        trace,
        surface,
        sessionId,
        specHash,
        structureHash,
        artifactId,
      });
      await record(
        "view.composed",
        payload as unknown as Record<string, unknown>,
        actorOf(spec, spec.provenance.tier === "L0" ? "system" : "model"),
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
                buildComponentGeneratedPayload({
                  spec,
                  trace,
                  artifactId,
                  artifact: sandboxNode.artifact,
                  ref: sandboxNode.data?.$ref,
                  specHash,
                }),
                actorOf(spec, "model"),
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
            ...(trace.correlationId != null ? { correlationId: trace.correlationId } : {}),
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
      // Unspecified optionals (kind / intentHash / sessionId / correlationId) are not stamped into the
      // payload (no undefined keys left behind). The tenant is stamped into the record's tenant field, not
      // into the payload.
      await record(
        "view.fallback",
        {
          specHash: args.specHash,
          reason: args.reason,
          surface: args.surface,
          ...(args.kind != null ? { kind: args.kind } : {}),
          ...(args.intentHash != null ? { intentHash: args.intentHash } : {}),
          ...(args.sessionId != null ? { sessionId: args.sessionId } : {}),
          ...(args.correlationId != null ? { correlationId: args.correlationId } : {}),
        },
        undefined,
        args.tenant,
      );
    },

    async componentUsed({ tenant, ...args }) {
      await record("component.used", { ...args }, undefined, tenant);
    },

    async policyApplied(event, actor, tenant) {
      // Unspecified optionals (previousPolicyId / label) are not stamped into the payload (no
      // undefined keys left behind) -- the same convention as viewFallback above.
      await record(
        "policy.applied",
        {
          policyId: event.policyId,
          ...(event.previousPolicyId != null ? { previousPolicyId: event.previousPolicyId } : {}),
          version: event.version,
          ...(event.label != null ? { label: event.label } : {}),
          changedPaths: event.changedPaths,
          tenants: event.tenants,
        },
        actor,
        tenant,
      );
    },

    async actionInvoked(event, actor, tenant) {
      await record(
        "action.invoked",
        {
          action: event.action,
          payloadHash: event.payloadHash,
          tier: event.tier,
          ...(event.correlationId != null ? { correlationId: event.correlationId } : {}),
        },
        actor,
        tenant,
      );
    },

    async actionDenied(event, actor, tenant) {
      await record(
        "action.denied",
        {
          action: event.action,
          payloadHash: event.payloadHash,
          tier: event.tier,
          reason: event.reason,
          ...(event.correlationId != null ? { correlationId: event.correlationId } : {}),
        },
        actor,
        tenant,
      );
    },

    async actionApprovalRequested(event, actor, tenant) {
      await record(
        "action.approvalRequested",
        {
          action: event.action,
          payloadHash: event.payloadHash,
          tier: event.tier,
          requestId: event.requestId,
          ...(event.payload != null ? { payload: event.payload } : {}),
          ...(event.correlationId != null ? { correlationId: event.correlationId } : {}),
        },
        actor,
        tenant,
      );
    },

    async actionApproved(event, actor, tenant) {
      await record(
        "action.approved",
        {
          action: event.action,
          payloadHash: event.payloadHash,
          approverId: event.approverId,
          requesterId: event.requesterId,
          ...(event.correlationId != null ? { correlationId: event.correlationId } : {}),
        },
        actor,
        tenant,
      );
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
