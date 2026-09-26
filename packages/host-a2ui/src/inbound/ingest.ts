import {
  cacheKey,
  canonicalStringify,
  computeStructureHash,
  type FixationRecord,
  finalizeIntent,
  type JsonObject,
  type Principal,
  sha256Hex,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { z } from "zod";
import { type A2uiIngestLoss, fromA2ui } from "./from-a2ui.js";
import { A2uiIngestError, reduceSurfaces, type SurfaceState, surfaceIdOf } from "./reduce.js";
import { type InboundA2uiMessage, parseInboundA2uiMessage } from "./schemas.js";

/**
 * `createA2uiIngest`'s view of the persistence it needs: the Spec cache and fixation lookup only — a
 * structural subset of spec-core's `StoragePort`, so any real `StoragePort` (including `storage-memory`'s,
 * used by this package's own tests as a devDependency) satisfies it as-is.
 */
export interface A2uiIngestStorage {
  getSpecCache(key: string): Promise<UISpec | null>;
  putSpecCache(key: string, spec: UISpec, ttlSeconds?: number): Promise<void>;
  getFixation(intentHash: string, tenant?: string): Promise<FixationRecord | null>;
}

/** The `view.composed`/`view.fallback` trace shape `A2uiIngestRecorder.composed` takes (matches `@kohaku-ui/lineage`'s `RestViewRecorder`). */
export interface A2uiIngestTrace {
  intent: { canonical: string; hash: string };
  dataVersion: string;
  cache: string;
  tier: "L0" | "L1" | "L2";
  model?: string;
  durationMs: number;
}

/**
 * `createA2uiIngest`'s view of lineage recording: a structural subset of `@kohaku-ui/lineage`'s
 * `RestViewRecorder` (its `composed`/`fallback` methods), so `createViewRecorder(lineage)` from that package
 * satisfies this as-is without host-a2ui depending on it at runtime (lineage is a devDependency here, used
 * only by `test/ingest.test.ts`).
 */
export interface A2uiIngestRecorder {
  composed(args: { spec: UISpec; trace: A2uiIngestTrace; surface: string; tenant?: string }): Promise<void>;
  fallback?(args: {
    spec: UISpec;
    reason: string;
    kind: "generation" | "negotiation";
    surface: string;
    tenant?: string;
  }): Promise<void>;
}

/** `createA2uiIngest`'s view of `@kohaku-ui/lineage`'s `Fixations.fixate` (the only method it calls). */
export interface A2uiIngestFixations {
  fixate(args: { pinnedSpec: UISpec; approver: Principal; tenant?: string }): Promise<FixationRecord>;
}

/**
 * Conservative default bounds for `ingest()` (all overridable via `CreateA2uiIngestOptions`). A schema-valid
 * A2UI message has no upper bound on how many of them a caller sends in one `ingest()` call, how many
 * components a surface accumulates across calls, or how large its data model grows — each is an independent
 * DoS lever (parse/fold cost, `fromA2ui` conversion cost, `canonicalStringify`/hashing cost, cache storage
 * size) that schema validation alone does not close. These three are deliberately coarse, cheap-to-check
 * bounds, not a precise resource budget.
 */
export const DEFAULT_MAX_MESSAGES_PER_INGEST = 1000;
export const DEFAULT_MAX_COMPONENTS_PER_SURFACE = 2000;
/** Measured as `JSON.stringify(dataModel).length` (UTF-16 code units — a portable size proxy that needs no Node `Buffer`/DOM `TextEncoder`, keeping this package's `src` free of any global assumption beyond plain JS). */
export const DEFAULT_MAX_DATA_MODEL_SIZE_BYTES = 1_048_576;

export interface CreateA2uiIngestOptions {
  storage: A2uiIngestStorage;
  recorder?: A2uiIngestRecorder;
  /** Forwarded to `fromA2ui`'s `catalog` option (see its doc). */
  catalog?: { has(type: string): boolean };
  /** Enables `A2uiIngest.fixate` (omit to leave fixation unsupported for this ingest instance). */
  fixations?: A2uiIngestFixations;
  /**
   * Serializes the cache read-modify-write for a given (tenant, intentHash) — the same shape as
   * `@kohaku-ui/host-core`'s `FixationDeliveryHost.serialize`, which both reference hosts wire to
   * `createKeyedMutex`. Omitted = unserialized (fine for a single-writer test or a single in-process ingest
   * instance with no concurrent calls for the same surface).
   */
  serialize?: <T>(
    scope: { tenant: string | undefined; intentHash: string },
    fn: () => Promise<T>,
  ) => Promise<T>;
  /**
   * Fired when the same cache key (same intentHash + dataVersion, so *by construction* expected to be
   * identical content) produces a structurally different Spec than what is already cached — a third-party
   * agent bug (reusing a dataVersion after actually changing its surface), not a kohaku bug. Purely
   * observational; does not change what `ingest()` returns (see `cachePolicy` for that).
   */
  onDrift?: (ctx: {
    key: string;
    intentHash: string;
    tenant: string | undefined;
    cachedStructureHash: string;
    freshStructureHash: string;
  }) => void;
  /**
   * What to serve when a drift (above) is detected. `"latest-wins"` (default): overwrite the cache with the
   * freshly-converted Spec (`cache: "miss"`). `"first-wins"`: keep serving whatever was cached first
   * (`cache: "hit"`), discarding the fresh conversion — useful when a flaky/misbehaving agent's later
   * messages should not perturb an already-displayed surface.
   */
  cachePolicy?: "first-wins" | "latest-wins";
  /**
   * The authenticated caller's identity (from the host's own auth, never taken from message payloads — see
   * the F3 brief). Folded into the default Intent's canonical name and into `generatorVersion`
   * (`a2ui-ingest/<agentId>`), so two different agents never share a cache entry or a fixation even if they
   * happen to send identically-shaped surfaces.
   */
  agentId: string;
  /** Forwarded to `fromA2ui`'s `unmappable` option (default `"fallback"`). */
  unmappable?: "fallback" | "reject";
  /** Forwarded to `fromA2ui`'s `bindPath` option. */
  bindPath?: (path: string) => { $ref: string } | undefined;
  /** Caps a single `ingest()` call's `messages` array length. Default {@link DEFAULT_MAX_MESSAGES_PER_INGEST}. */
  maxMessagesPerIngest?: number;
  /** Caps a surface's total component count after folding (across every `ingest()` call so far, not just this one). Default {@link DEFAULT_MAX_COMPONENTS_PER_SURFACE}. */
  maxComponentsPerSurface?: number;
  /** Caps the data model's serialized size (see {@link DEFAULT_MAX_DATA_MODEL_SIZE_BYTES} for how it is measured). Default {@link DEFAULT_MAX_DATA_MODEL_SIZE_BYTES}. */
  maxDataModelSizeBytes?: number;
}

/** Per-call override of what `ingest()` would otherwise derive on its own. */
export interface A2uiIngestMeta {
  /** Recommended: an explicit Intent, so repeated ingests of the same live surface share one cache entry (see the README's "governance proxy" section — the default Intent is derived from surfaceId, so it rarely repeats). */
  intent?: { canonical: string; params?: JsonObject };
  /** Overrides the default `"a2ui:" + sha256(canonical dataModel).slice(0,16)` derivation. */
  dataVersion?: string;
  tenant?: string;
}

export interface A2uiIngestOutcome {
  spec: UISpec;
  losses: A2uiIngestLoss[];
  cache: "hit" | "miss" | "fixated";
}

export interface A2uiIngest {
  /**
   * Folds `messages` (raw JSON off the wire; schema-validated here) onto this ingest's surface state, then
   * converts the targeted surface into a Spec (or returns the fixation shortcut). All messages in one call
   * must target the same surfaceId (mixing surfaces requires separate calls — see `surfaceIdOf`).
   */
  ingest(messages: unknown[], meta?: A2uiIngestMeta): Promise<A2uiIngestOutcome>;
  /** The last `ingest()` outcome recorded for `surfaceId` (`undefined` if it was never ingested). */
  latest(surfaceId: string): A2uiIngestOutcome | undefined;
  /** Pins the latest ingest outcome for `surfaceId` via `opts.fixations` (throws if none was configured, or if the surface has no ingest outcome yet). */
  fixate(surfaceId: string, approver: Principal): Promise<FixationRecord>;
}

/** `a2ui.<agent_slug>.<surface_slug>`, matching spec-core's `CanonicalNameSchema` (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`). */
function defaultCanonical(agentId: string, surfaceId: string): string {
  return `a2ui.${slugSegment(agentId)}.${slugSegment(surfaceId)}`;
}

/** Deterministic best-effort mapping of an arbitrary string to one `CanonicalNameSchema` segment (`[a-z][a-z0-9_]*`). */
function slugSegment(input: string): string {
  const collapsed = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (collapsed === "") return "a";
  return /^[a-z]/.test(collapsed) ? collapsed : `a_${collapsed}`;
}

async function deriveDataVersion(dataModel: JsonObject): Promise<string> {
  const hex = await sha256Hex(canonicalStringify(dataModel));
  return `a2ui:${hex.slice(0, 16)}`;
}

function buildCacheKey(
  intentHash: string,
  dataVersion: string,
  agentId: string,
  tenant: string | undefined,
): string {
  const base = cacheKey({ intentHash, dataVersion, generatorVersion: `a2ui-ingest/${agentId}` });
  return tenant != null ? `${base}:${tenant}` : base;
}

/** See the F3 brief (§5) / the package README's "governance proxy" section for the design this implements. */
export function createA2uiIngest(opts: CreateA2uiIngestOptions): A2uiIngest {
  let surfaces = new Map<string, SurfaceState>();
  const latestBySurface = new Map<string, { outcome: A2uiIngestOutcome; tenant: string | undefined }>();

  async function recordComposed(
    canonicalIntent: { canonical: string; hash: string },
    spec: UISpec,
    cache: A2uiIngestOutcome["cache"],
    durationMs: number,
    tenant: string | undefined,
  ): Promise<void> {
    await opts.recorder?.composed({
      spec,
      trace: {
        intent: canonicalIntent,
        dataVersion: spec.dataVersion,
        cache,
        tier: "L1",
        model: `a2ui:${opts.agentId}`,
        durationMs,
      },
      surface: "a2ui",
      ...(tenant != null ? { tenant } : {}),
    });
  }

  async function ingest(messages: unknown[], meta?: A2uiIngestMeta): Promise<A2uiIngestOutcome> {
    const startedAt = Date.now();
    // Cheapest possible check first, before parsing/validating a single message: a pathologically large
    // messages array costs work (schema validation, folding) regardless of what each message contains.
    const maxMessages = opts.maxMessagesPerIngest ?? DEFAULT_MAX_MESSAGES_PER_INGEST;
    if (messages.length > maxMessages) {
      throw new A2uiIngestError(
        `ingest(): received ${messages.length} messages in one call, exceeding maxMessagesPerIngest (${maxMessages})`,
      );
    }
    // Security: parseInboundA2uiMessage's own raw-depth pre-check (see its doc) closes the main
    // stack-exhaustion gap, but this is still a second, unconditional line of defense at the ingest()
    // boundary itself: any exception that is not already one of the two clean, expected shapes (a
    // `z.ZodError` from schema validation, or our own `A2uiIngestError`) — most notably a `RangeError` from
    // some future/overlooked pathologically deep or wide input — is mapped to a clean `A2uiIngestError`
    // here rather than escaping `ingest()` as a raw, unexpected exception type a caller cannot reasonably
    // plan for.
    let parsed: InboundA2uiMessage[];
    try {
      parsed = messages.map(parseInboundA2uiMessage);
    } catch (e) {
      if (e instanceof z.ZodError || e instanceof A2uiIngestError) throw e;
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new A2uiIngestError(`ingest(): failed to parse inbound messages (${detail})`);
    }
    const surfaceIds = new Set(parsed.map(surfaceIdOf));
    if (surfaceIds.size !== 1) {
      throw new A2uiIngestError(
        `ingest(): all messages in one call must target exactly one surface, got ${surfaceIds.size}: ${[...surfaceIds].join(", ")}`,
      );
    }
    const surfaceId = [...surfaceIds][0]!;
    for (const message of parsed) surfaces = reduceSurfaces(surfaces, message);
    const surface = surfaces.get(surfaceId);
    if (surface == null) {
      throw new A2uiIngestError(
        `ingest(): surface "${surfaceId}" no longer exists (its last message deleted it)`,
      );
    }

    // Bounds on the *accumulated* surface state, checked regardless of whether this call turns out to be a
    // fixation hit below — these guard against unbounded growth across many ingest() calls over a surface's
    // lifetime, not just this one call's own messages.
    const maxComponents = opts.maxComponentsPerSurface ?? DEFAULT_MAX_COMPONENTS_PER_SURFACE;
    const componentCount = Object.keys(surface.components).length;
    if (componentCount > maxComponents) {
      throw new A2uiIngestError(
        `ingest(): surface "${surfaceId}" has ${componentCount} components, exceeding maxComponentsPerSurface (${maxComponents})`,
      );
    }
    const maxDataModelSize = opts.maxDataModelSizeBytes ?? DEFAULT_MAX_DATA_MODEL_SIZE_BYTES;
    const dataModelSize = JSON.stringify(surface.dataModel).length;
    if (dataModelSize > maxDataModelSize) {
      throw new A2uiIngestError(
        `ingest(): surface "${surfaceId}"'s data model is ${dataModelSize} (JSON.stringify length), exceeding maxDataModelSizeBytes (${maxDataModelSize})`,
      );
    }

    const tenant = meta?.tenant;
    const canonical = meta?.intent?.canonical ?? defaultCanonical(opts.agentId, surfaceId);
    const params = meta?.intent?.params ?? { agent: opts.agentId, surfaceId };
    const intent = await finalizeIntent({ canonical, params });

    // Fixation shortcut, checked before any conversion work — mirrors host-core's composeWithFixation (the
    // structure is fixed; only $ref-resolved data would normally refresh, but an ingested surface has none
    // of that, so this is a pure "serve the pinned Spec" short-circuit).
    const fixation = await opts.storage.getFixation(intent.hash, tenant);
    if (fixation != null) {
      const spec: UISpec = {
        ...fixation.pinnedSpec,
        provenance: { ...fixation.pinnedSpec.provenance, cache: "fixated" },
      };
      const outcome: A2uiIngestOutcome = { spec, losses: [], cache: "fixated" };
      latestBySurface.set(surfaceId, { outcome, tenant });
      await recordComposed(intent, spec, "fixated", Date.now() - startedAt, tenant);
      return outcome;
    }

    const dataVersion = meta?.dataVersion ?? (await deriveDataVersion(surface.dataModel));
    const key = buildCacheKey(intent.hash, dataVersion, opts.agentId, tenant);

    const converted = fromA2ui(surface, {
      intent,
      dataVersion,
      // Always "untrusted" and never taken from CreateA2uiIngestOptions: createA2uiIngest exists
      // specifically to ingest content whose trust this host cannot itself vouch for, so there is no safe
      // way to expose this as a caller-settable option here (see FromA2uiOptions.trust's doc). A caller
      // that genuinely needs to replay kohaku's own prior toA2ui output losslessly (trust: "trusted") calls
      // fromA2ui directly instead of going through this ingest pipeline.
      trust: "untrusted",
      ...(opts.catalog != null ? { catalog: opts.catalog } : {}),
      ...(opts.unmappable != null ? { unmappable: opts.unmappable } : {}),
      ...(opts.bindPath != null ? { bindPath: opts.bindPath } : {}),
    });
    const losses = converted.losses;
    // Stamped onto the Spec itself (not just the recorder trace below) so it round-trips through the cache
    // and so lineage's own view.composed payload — which reads spec.provenance.model, not the trace argument
    // — actually captures which agent's ingest produced this Spec.
    const freshSpec: UISpec = {
      ...converted.spec,
      provenance: { ...converted.spec.provenance, model: `a2ui:${opts.agentId}` },
    };

    const run = async (): Promise<{ spec: UISpec; cache: "hit" | "miss" }> => {
      const cached = await opts.storage.getSpecCache(key);
      if (cached == null) {
        await opts.storage.putSpecCache(key, freshSpec);
        return { spec: freshSpec, cache: "miss" };
      }
      const [cachedStructureHash, freshStructureHash] = await Promise.all([
        computeStructureHash(cached),
        computeStructureHash(freshSpec),
      ]);
      if (cachedStructureHash === freshStructureHash) {
        return { spec: freshSpec, cache: "hit" };
      }
      // Drift: the same (intentHash, dataVersion) key produced different content than what is cached — by
      // construction this should never happen (identical key implies identical input), so it signals a
      // misbehaving agent (e.g. reusing a dataVersion after actually changing its surface), not a kohaku bug.
      opts.onDrift?.({ key, intentHash: intent.hash, tenant, cachedStructureHash, freshStructureHash });
      if ((opts.cachePolicy ?? "latest-wins") === "first-wins") {
        return { spec: cached, cache: "hit" };
      }
      await opts.storage.putSpecCache(key, freshSpec);
      return { spec: freshSpec, cache: "miss" };
    };

    const { spec: servedSpec, cache } =
      opts.serialize != null ? await opts.serialize({ tenant, intentHash: intent.hash }, run) : await run();

    const spec: UISpec = { ...servedSpec, provenance: { ...servedSpec.provenance, cache } };
    const outcome: A2uiIngestOutcome = { spec, losses, cache };
    latestBySurface.set(surfaceId, { outcome, tenant });

    await recordComposed(intent, spec, cache, Date.now() - startedAt, tenant);
    if (losses.length > 0) {
      const first = losses[0]!;
      await opts.recorder?.fallback?.({
        spec,
        reason: first.detail,
        kind: "negotiation",
        surface: "a2ui",
        ...(tenant != null ? { tenant } : {}),
      });
    }
    return outcome;
  }

  return {
    ingest,
    latest(surfaceId) {
      return latestBySurface.get(surfaceId)?.outcome;
    },
    async fixate(surfaceId, approver) {
      if (opts.fixations == null) {
        throw new A2uiIngestError("fixate(): createA2uiIngest was not given a `fixations` option");
      }
      const entry = latestBySurface.get(surfaceId);
      if (entry == null) {
        throw new A2uiIngestError(`fixate(): surface "${surfaceId}" has no ingested result yet`);
      }
      return opts.fixations.fixate({
        pinnedSpec: entry.outcome.spec,
        approver,
        ...(entry.tenant != null ? { tenant: entry.tenant } : {}),
      });
    },
  };
}
