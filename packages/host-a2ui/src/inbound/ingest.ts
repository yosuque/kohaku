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
import { type A2uiIngestLoss, fromA2ui, isPlaceholderLoss } from "./from-a2ui.js";
import {
  A2uiIngestError,
  copyComponents,
  reduceSurfaceMessage,
  type SurfaceState,
  surfaceIdOf,
} from "./reduce.js";
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
 * components a surface accumulates across calls, how large its data model grows, or how many surfaces an
 * ingest instance tracks — each is an independent DoS lever (parse/fold cost, `fromA2ui` conversion cost,
 * `canonicalStringify`/hashing cost, cache storage size, retained memory) that schema validation alone does
 * not close. These are deliberately coarse, cheap-to-check bounds, not a precise resource budget.
 */
export const DEFAULT_MAX_MESSAGES_PER_INGEST = 1000;
export const DEFAULT_MAX_COMPONENTS_PER_SURFACE = 2000;
/** Measured as the UTF-8 byte length of `JSON.stringify(dataModel)`. */
export const DEFAULT_MAX_DATA_MODEL_SIZE_BYTES = 1_048_576;
/** How many (tenant, surfaceId) surfaces an ingest instance keeps state for before evicting the least recently ingested one. */
export const DEFAULT_MAX_SURFACES = 1000;

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
   * the README's "governance proxy" section). Folded into the default Intent's canonical name and into `generatorVersion`
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
  /** Caps the data model's serialized size in UTF-8 bytes (of `JSON.stringify(dataModel)`). Default {@link DEFAULT_MAX_DATA_MODEL_SIZE_BYTES}. */
  maxDataModelSizeBytes?: number;
  /**
   * Caps how many (tenant, surfaceId) surfaces this instance tracks; past it the least recently ingested
   * surface (its state and its `latest()` outcome) is evicted, so a later `ingest()` for it must start with
   * a fresh `createSurface`. Default {@link DEFAULT_MAX_SURFACES}.
   */
  maxSurfaces?: number;
}

/** Per-call override of what `ingest()` would otherwise derive on its own. */
export interface A2uiIngestMeta {
  /** Recommended: an explicit Intent, so repeated ingests of the same live surface share one cache entry (see the README's "governance proxy" section — the default Intent is derived from surfaceId, so it rarely repeats). */
  intent?: { canonical: string; params?: JsonObject };
  /** Overrides the default `"a2ui:" + sha256(canonical dataModel).slice(0,16)` derivation. */
  dataVersion?: string;
  /**
   * Scopes the surface state (not only the cache key) to this tenant: the same `surfaceId` under two tenants
   * is two independent surfaces, so one tenant can neither read, extend nor fixate another's.
   */
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
   *
   * Atomic per call: the batch is folded onto a private copy of the surface, the bounds are checked, and only
   * then is it committed — a call that throws (a malformed sequence, or an over-limit surface) leaves the
   * surface exactly as it was. The one committed outcome that also throws is a batch that ends in
   * `deleteSurface`, which removes the surface and then reports that there is nothing to convert.
   */
  ingest(messages: unknown[], meta?: A2uiIngestMeta): Promise<A2uiIngestOutcome>;
  /** The last `ingest()` outcome recorded for `surfaceId` under `tenant` (`undefined` if it was never ingested, was deleted, or was evicted). */
  latest(surfaceId: string, tenant?: string): A2uiIngestOutcome | undefined;
  /**
   * Pins the latest ingest outcome for `surfaceId` (under `tenant`) via `opts.fixations` (throws if none was
   * configured, if the surface has no ingest outcome yet, or if that outcome is a degraded rendering that
   * SPEC.md §8 forbids fixating — see `provenance.fallback`). The pinned Spec is a literal snapshot: an
   * ingested surface has no `$ref` data, so fixating it freezes its data along with its structure.
   */
  fixate(surfaceId: string, approver: Principal, tenant?: string): Promise<FixationRecord>;
}

/** One tracked surface: its accumulated state and the last outcome `ingest()` produced for it. */
interface SurfaceEntry {
  state: SurfaceState;
  latest?: A2uiIngestOutcome;
}

/** Surface state is keyed by (tenant, surfaceId), JSON-encoded so no tenant/surface pair can collide with another. */
function surfaceKey(tenant: string | undefined, surfaceId: string): string {
  return JSON.stringify([tenant ?? null, surfaceId]);
}

/** UTF-8 byte length of `text` without allocating an encoded copy (a lone surrogate counts as U+FFFD, 3 bytes, as `TextEncoder` does). */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** `a2ui.<agent_slug>.<surface_slug>`, matching spec-core's `CanonicalNameSchema` (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`). */
function defaultCanonical(agentId: string, surfaceId: string): string {
  return `a2ui.${slugSegment(agentId)}.${slugSegment(surfaceId)}`;
}

/**
 * The raw (pre-slug) input `slugSegment` will look at. `agentId`/`surfaceId` are otherwise unbounded
 * strings (an agent chooses its own `surfaceId`), so this keeps the whole default-canonical derivation —
 * and, in particular, `trimUnderscoreRuns` below — bounded to a small constant amount of work regardless of
 * how long the input actually is.
 */
const MAX_SLUG_INPUT_LENGTH = 128;

/**
 * Trims leading/trailing `"_"` with a plain index walk from each end — **not** a regex. A regex shaped like
 * `/^_+|_+$/` is exactly `js/polynomial-redos` (CodeQL alert): its second alternative, `_+$`, is not itself
 * anchored at the *start*, so on a long run of `"_"` that is not already at the true end of the string (e.g.
 * one sitting in the interior after the surrounding text is collapsed by the caller's own
 * `[^a-z0-9]+` → `"_"` pass), the engine retries the greedy-match-then-backtrack-against-`$` dance at every
 * position within that run, an O(k) cost repeated k times = O(k²) for a run of length k. An index walk has
 * no backtracking to begin with, so it stays O(n) regardless of input shape.
 */
function trimUnderscoreRuns(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && input[start] === "_") start++;
  while (end > start && input[end - 1] === "_") end--;
  return input.slice(start, end);
}

/** Deterministic best-effort mapping of an arbitrary string to one `CanonicalNameSchema` segment (`[a-z][a-z0-9_]*`). */
function slugSegment(input: string): string {
  const bounded = input.length > MAX_SLUG_INPUT_LENGTH ? input.slice(0, MAX_SLUG_INPUT_LENGTH) : input;
  const collapsed = trimUnderscoreRuns(bounded.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
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

/** See the package README's "Inbound: A2UI agent → kohaku Spec (ingest, a governance proxy)" section for the design this implements. */
export function createA2uiIngest(opts: CreateA2uiIngestOptions): A2uiIngest {
  // Insertion order doubles as recency order (a commit re-inserts its key last), so the first key is the
  // least recently ingested surface — the one `maxSurfaces` evicts.
  const entries = new Map<string, SurfaceEntry>();
  const maxSurfaces = Math.max(1, opts.maxSurfaces ?? DEFAULT_MAX_SURFACES);

  function commit(key: string, state: SurfaceState): void {
    const previous = entries.get(key);
    entries.delete(key);
    entries.set(key, { state, ...(previous?.latest != null ? { latest: previous.latest } : {}) });
    while (entries.size > maxSurfaces) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  /** Records `outcome` as the surface's latest unless it was deleted or evicted while `ingest()` awaited. */
  function setLatest(key: string, outcome: A2uiIngestOutcome): void {
    const entry = entries.get(key);
    if (entry != null) entry.latest = outcome;
  }

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
        tier: spec.provenance.tier,
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
    const tenant = meta?.tenant;
    const surfaceEntryKey = surfaceKey(tenant, surfaceId);

    // Fold the whole batch onto a private copy of the surface (its components copied once, not per message),
    // and commit it only after the bounds below pass: everything up to `commit` is synchronous, so a throw
    // anywhere in here (a reducer error mid-batch, an over-limit result) leaves the committed state untouched.
    const previous = entries.get(surfaceEntryKey)?.state;
    let surface: SurfaceState | undefined =
      previous != null ? { ...previous, components: copyComponents(previous.components) } : undefined;
    for (const message of parsed) {
      surface = reduceSurfaceMessage(surface, message, { inPlaceComponents: true });
    }
    if (surface == null) {
      entries.delete(surfaceEntryKey);
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
    const dataModelSize = utf8ByteLength(JSON.stringify(surface.dataModel));
    if (dataModelSize > maxDataModelSize) {
      throw new A2uiIngestError(
        `ingest(): surface "${surfaceId}"'s data model is ${dataModelSize} bytes (UTF-8 JSON), exceeding maxDataModelSizeBytes (${maxDataModelSize})`,
      );
    }
    commit(surfaceEntryKey, surface);

    const canonical = meta?.intent?.canonical ?? defaultCanonical(opts.agentId, surfaceId);
    const params = meta?.intent?.params ?? { agent: opts.agentId, surfaceId };
    const intent = await finalizeIntent({ canonical, params });

    // Fixation shortcut, checked before any conversion work — mirrors host-core's composeWithFixation (the
    // structure is fixed; only $ref-resolved data would normally refresh, but an ingested surface has none
    // of that, so this is a pure "serve the pinned Spec" short-circuit that also freezes the data snapshot).
    // Served as tier L0 (SPEC.md §8), like composer's materializeFixation, so disclosure and analytics see a
    // fixated Spec rather than a fresh L1 generation.
    const fixation = await opts.storage.getFixation(intent.hash, tenant);
    if (fixation != null) {
      const spec: UISpec = {
        ...fixation.pinnedSpec,
        provenance: { ...fixation.pinnedSpec.provenance, tier: "L0", cache: "fixated" },
      };
      const outcome: A2uiIngestOutcome = { spec, losses: [], cache: "fixated" };
      setLatest(surfaceEntryKey, outcome);
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
    setLatest(surfaceEntryKey, outcome);

    await recordComposed(intent, spec, cache, Date.now() - startedAt, tenant);
    // view.fallback only for a loss that substituted a placeholder; a snapshotted `{path}` binding is
    // ordinary A2UI (see isPlaceholderLoss).
    const firstPlaceholder = losses.find(isPlaceholderLoss);
    if (firstPlaceholder != null) {
      await opts.recorder?.fallback?.({
        spec,
        reason: firstPlaceholder.detail,
        kind: "negotiation",
        surface: "a2ui",
        ...(tenant != null ? { tenant } : {}),
      });
    }
    return outcome;
  }

  return {
    ingest,
    latest(surfaceId, tenant) {
      return entries.get(surfaceKey(tenant, surfaceId))?.latest;
    },
    async fixate(surfaceId, approver, tenant) {
      if (opts.fixations == null) {
        throw new A2uiIngestError("fixate(): createA2uiIngest was not given a `fixations` option");
      }
      const outcome = entries.get(surfaceKey(tenant, surfaceId))?.latest;
      if (outcome == null) {
        throw new A2uiIngestError(`fixate(): surface "${surfaceId}" has no ingested result yet`);
      }
      const fallback = outcome.spec.provenance.fallback;
      if (fallback != null) {
        throw new A2uiIngestError(
          `fixate(): surface "${surfaceId}"'s latest result is a degraded rendering (${fallback.reason}) and cannot be fixated`,
        );
      }
      try {
        return await opts.fixations.fixate({
          pinnedSpec: outcome.spec,
          approver,
          ...(tenant != null ? { tenant } : {}),
        });
      } catch (e) {
        // `Fixations.fixate` (lineage) enforces the same SPEC.md §8 rule for L2 / fallback Specs with a typed
        // error this package cannot import; surface it as the ingest pipeline's own error type.
        if (e instanceof Error && e.name === "FixationNotAllowedError") {
          throw new A2uiIngestError(`fixate(): ${e.message}`);
        }
        throw e;
      }
    },
  };
}
