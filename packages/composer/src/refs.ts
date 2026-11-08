import {
  type CanonicalIntent,
  combineDataVersions,
  type DataShape,
  type FilterDescriptor,
  type QueryHandle,
} from "@kohaku-ui/spec-core";
import type { ComposeContext } from "./context.js";
import { isClientSafeCause } from "./error-message.js";
import { ComposeError } from "./errors.js";
import { dropShapeChangingFilters } from "./filter-shape-guard.js";

export interface ResolvedRefs {
  handles: QueryHandle[];
  uris: string[];
  shapesByRef: Map<string, DataShape>;
  dataVersion: string;
  /** $ref URI → the dataVersion of that reference alone. The fill source for Spec.refVersions. */
  versionsByRef: Record<string, string>;
  /**
   * The Intent's GUI filters (`SemanticPort.describeFilters`), resolved only under `ComposePolicy.l1Filters`.
   * Absent otherwise (and when the port does not implement it or the call failed -- fail-open, like
   * describeShape); `fixation.ts` builds a ResolvedRefs without it.
   */
  descriptors?: FilterDescriptor[];
}

/** The result of resolveHandleVersions: resolved handles + their combined/per-ref dataVersion. */
export interface ResolvedHandleVersions {
  handles: QueryHandle[];
  /** Per-handle dataVersion, in the same order as handles. */
  versions: string[];
  dataVersion: string;
  /** $ref URI → the dataVersion of that reference alone. */
  versionsByRef: Record<string, string>;
}

/**
 * Shared core of reference resolution: resolveQuery → array-ify → parallel dataVersion →
 * combineDataVersions → versionsByRef. Extracted because compose.ts's resolveRefs and fixation.ts's
 * materializeFixation both need exactly this sequence (they differ only in what they do around it:
 * describeShape, and whether a resolveQuery failure gets wrapped as a ComposeError).
 *
 * A resolveQuery failure propagates as-is (fixation.ts's pass-through, the default). Callers that need
 * to wrap it (compose.ts's resolveRefs wraps it as ComposeError("SEMANTIC_FAILED", ...)) pass
 * `onResolveError`, called with the raw error before it is re-thrown; a hook that itself throws (or
 * returns `never`) fully replaces the propagated error, matching compose.ts's current behavior exactly.
 */
export async function resolveHandleVersions(
  intent: CanonicalIntent,
  ctx: ComposeContext,
  tenant?: string,
  opts: { onResolveError?: (error: unknown) => never } = {},
): Promise<ResolvedHandleVersions> {
  let resolved: QueryHandle | QueryHandle[];
  try {
    resolved = await ctx.semantic.resolveQuery(intent, tenant != null ? { tenant } : undefined);
  } catch (e) {
    if (opts.onResolveError != null) opts.onResolveError(e);
    throw e;
  }
  const handles = Array.isArray(resolved) ? resolved : [resolved];
  const versions = await Promise.all(handles.map((h) => ctx.semantic.dataVersion(h)));
  const dataVersion = await combineDataVersions(
    handles.map((h, i) => ({ uri: h.uri, version: versions[i]! })),
  );
  const versionsByRef = Object.fromEntries(handles.map((h, i) => [h.uri, versions[i]!]));
  return { handles, versions, dataVersion, versionsByRef };
}

export async function resolveRefs(
  intent: CanonicalIntent,
  ctx: ComposeContext,
  tenant?: string,
  locale?: string,
): Promise<ResolvedRefs> {
  // Propagate tenant to resolveQuery to correctly resolve per-tenant promoted Intents.
  // A resolveQuery failure is wrapped as SEMANTIC_FAILED here (fixation.ts's materializeFixation shares
  // the same resolution sequence via resolveHandleVersions but lets the failure pass through as-is).
  // When the cause explicitly opts in via `clientSafe === true` (see isClientSafeCause's doc — deliberately
  // narrower than "any Error with a string `code`", since a SemanticPort can throw a raw pg/fs/ioredis/fetch
  // error whose `code` is also a string but whose `message` carries hostnames/paths/table names), its own
  // message is appended so the caller learns *what* failed (e.g. an unknown Intent name) instead of the
  // generic text alone. Every other cause (including one with an unrelated string `code`) may carry
  // internals and is never appended — the wrapped message stays exactly as before for that case.
  const { handles, dataVersion, versionsByRef } = await resolveHandleVersions(intent, ctx, tenant, {
    onResolveError: (e) => {
      const detail = isClientSafeCause(e) ? `: ${e.message}` : "";
      throw new ComposeError("SEMANTIC_FAILED", `query resolution failed${detail}`, { cause: e });
    },
  });

  const shapesByRef = new Map<string, DataShape>();
  if (ctx.semantic.describeShape != null) {
    await Promise.all(
      handles.map(async (h) => {
        try {
          shapesByRef.set(h.uri, await ctx.semantic.describeShape!(h));
        } catch {
          // If the shape cannot be obtained, rules such as the chart-kind rule are skipped (an optional extension)
        }
      }),
    );
  }

  // Intent-declared filters for L1 injection (ComposePolicy.l1Filters). The session's locale selects the label
  // language; prepareCompose folds a hash of the returned descriptors into the cache key, so Specs for
  // different locales / tenant option lists are cached separately. A failure only means "no filters" (an
  // optional enhancement must not fail the compose), like describeShape above.
  let descriptors: FilterDescriptor[] | undefined;
  if (ctx.policy?.l1Filters === true && ctx.semantic.describeFilters != null) {
    try {
      const describeCtx = { ...(tenant != null ? { tenant } : {}), ...(locale != null ? { locale } : {}) };
      descriptors = await ctx.semantic.describeFilters(
        intent,
        Object.keys(describeCtx).length > 0 ? describeCtx : undefined,
      );
      // Defence in depth (design.md #78): a filter whose options rename the result's columns would blank the
      // generated chart / table, so it is dropped. The cache key hashes the descriptors actually used.
      const describe = ctx.semantic.describeShape?.bind(ctx.semantic);
      descriptors = await dropShapeChangingFilters(descriptors, handles, shapesByRef, describe);
    } catch {
      descriptors = undefined;
    }
  }

  return {
    handles,
    uris: handles.map((h) => h.uri),
    shapesByRef,
    dataVersion,
    versionsByRef,
    ...(descriptors != null && descriptors.length > 0 ? { descriptors } : {}),
  };
}
