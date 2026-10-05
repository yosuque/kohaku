import type { LineageEventRecord, StoragePort, SuggestedDraft } from "@kohaku-ui/spec-core";

/**
 * One reviewer-corrected case for the schema extractor's prompt (design.md #73): the draft the reviewer finally
 * approved, the machine proposal it replaced, and the head of the component's HTML. Structurally the same as
 * `@kohaku-ui/evals`' `SchemaExtractionExample` (lineage may not import evals, so the shape is restated; both
 * use spec-core's `SuggestedDraft`).
 */
export interface SchemaEditExample {
  htmlExcerpt?: string;
  suggestion?: SuggestedDraft;
  final: SuggestedDraft;
}

export interface SchemaEditExamplesOptions {
  /** How many examples one call returns (default 2). */
  limit?: number;
  /**
   * How long (milliseconds) one tenant's result is reused before the log is read again (default 5000; 0 turns
   * the memo off). A nomination pass asks for examples once per candidate, all for the same tenant within a
   * moment, so the log is read once per pass instead of once per candidate. A reviewer correction therefore
   * reaches the prompt at most this long after it was recorded.
   */
  cacheTtlMs?: number;
  /** Clock injection point (tests only; defaults to `Date.now`). */
  now?: () => number;
}

/**
 * What the provider reads from the extraction call: structurally `@kohaku-ui/evals`' `SchemaExtractionInput`
 * narrowed to the one field that decides whose records may be read, so the provider plugs straight into
 * `createSchemaExtractor({ examples })`.
 */
export interface SchemaEditExamplesInput {
  /**
   * The tenant whose reviewer corrections may be reused. With a tenant, only that tenant's records are read
   * (the storage filters, not a pass over everyone's rows). Without one, only records that carry **no** tenant
   * are used: the extractor is built once per process and shared by every tenant, so one tenant's component
   * HTML and naming must never reach another tenant's prompt (and, through the suggestion, its review form).
   */
  tenant?: string;
}

const DEFAULT_LIMIT = 2;
/** How long one tenant's examples are reused before the log is read again. */
const DEFAULT_CACHE_TTL_MS = 5_000;
/** How many recent `component.schemaEdited` records are considered (one query). */
const SCAN_WINDOW = 200;
/**
 * How many of one artifact's records a per-artifact lookup reads when no tenant narrows the query. The same
 * artifactId (a content hash) can be promoted by several tenants, whose records interleave; a tenant-less call
 * keeps only the tenant-less ones, so it reads a few more than the one it needs.
 */
const ARTIFACT_WINDOW = 20;
/** Characters of the artifact's HTML kept per example (the prompt side cuts to the same length). */
const HTML_EXCERPT_CHARS = 1_500;

function isDraft(value: unknown): value is SuggestedDraft {
  if (value == null || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d["componentType"] === "string" &&
    typeof d["version"] === "string" &&
    typeof d["intentName"] === "string" &&
    typeof d["description"] === "string"
  );
}

/**
 * Builds the `examples` provider for `@kohaku-ui/evals`' `createSchemaExtractor` from the lineage log: the
 * most recent cases where a reviewer **changed** the machine's schema suggestion (`component.schemaEdited`
 * with a non-empty `changed`; an accepted-as-is suggestion teaches nothing new), newest first, at most one per
 * artifact, each joined with that artifact's latest `component.schemaProposed` (the final draft; a case with
 * none is skipped), `component.schemaSuggested` (the replaced proposal) and `component.generated` (the HTML).
 *
 * One read of the newest 200 `component.schemaEdited` records, and nothing more when none of them carries an
 * edit (the common case: most tenants never correct a suggestion). Only the artifacts that become examples
 * (at most `limit`) are then looked up, each by its own `artifactId`, so a component's HTML is never read for
 * the 200 records of a window, and a case whose proposal is missing costs one lookup and is skipped. The
 * result is reused per tenant for `cacheTtlMs` (default 5 s; see the option), shared by calls that arrive
 * while it is being computed. Read-only; a storage failure rejects (and is not remembered), which the
 * extractor treats as "no examples". The `signal` the extractor passes is only checked before the read and
 * after it, because the computation is shared between callers: the extractor stops waiting for a slow
 * provider on its own when its budget is spent.
 */
export function schemaEditExamples(
  storage: StoragePort,
  opts: SchemaEditExamplesOptions = {},
): (
  input: SchemaEditExamplesInput,
  ctx?: { signal?: { readonly aborted: boolean } },
) => Promise<SchemaEditExample[]> {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const ttlMs = Math.max(0, opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const clock = opts.now ?? Date.now;
  /** tenant ("" for none) -> the computation started at `at`; a rejected one removes itself. */
  const memo = new Map<string, { at: number; result: Promise<SchemaEditExample[]> }>();

  const compute = async (tenant: string | undefined): Promise<SchemaEditExample[]> => {
    // With a tenant the storage already narrows to it; the exact-match check only guards an adapter that
    // ignores the filter. Without one, "no tenant" means both an absent field and an empty string.
    const inScope = (e: LineageEventRecord): boolean =>
      tenant != null ? e.tenant === tenant : e.tenant == null || e.tenant === "";
    const tenantFilter = tenant != null ? { tenant } : {};

    const edited = (
      await storage.listLineage({ type: ["component.schemaEdited"], limit: SCAN_WINDOW, ...tenantFilter })
    ).filter(inScope);
    // Newest first: by timestamp, and for equal timestamps the later append wins. One candidate per artifact,
    // and only an edit that actually changed the suggestion.
    const candidates: string[] = [];
    const seen = new Set<string>();
    const newestFirst = edited
      .map((event, index) => ({ event, index }))
      .sort((a, b) => (a.event.ts === b.event.ts ? b.index - a.index : a.event.ts < b.event.ts ? 1 : -1));
    for (const { event } of newestFirst) {
      const changed = event.payload["changed"];
      const artifactId = event.payload["artifactId"];
      if (!Array.isArray(changed) || changed.length === 0) continue;
      if (typeof artifactId !== "string" || artifactId === "" || seen.has(artifactId)) continue;
      seen.add(artifactId);
      candidates.push(artifactId);
    }
    // Nothing was corrected: there is nothing to join, so do not read the other three event types at all.
    if (candidates.length === 0) return [];

    /** The latest record of `type` for one artifact (the log is in append order, so the last one wins). */
    const latestOf = async (type: string, artifactId: string): Promise<LineageEventRecord | undefined> => {
      const records = (
        await storage.listLineage({
          type: [type],
          artifactId,
          limit: tenant != null ? 1 : ARTIFACT_WINDOW,
          ...tenantFilter,
        })
      ).filter(inScope);
      return records[records.length - 1];
    };

    const examples: SchemaEditExample[] = [];
    for (const artifactId of candidates) {
      if (examples.length >= limit) break;
      const final = (await latestOf("component.schemaProposed", artifactId))?.payload["draft"];
      if (!isDraft(final)) continue;
      const [suggested, generated] = await Promise.all([
        latestOf("component.schemaSuggested", artifactId),
        latestOf("component.generated", artifactId),
      ]);
      const suggestion = suggested?.payload["suggestion"];
      const suggestedDraft =
        suggestion != null && typeof suggestion === "object"
          ? (suggestion as Record<string, unknown>)["draft"]
          : undefined;
      const html = generated?.payload["html"];

      examples.push({
        final,
        ...(isDraft(suggestedDraft) ? { suggestion: suggestedDraft } : {}),
        ...(typeof html === "string" && html !== ""
          ? { htmlExcerpt: html.slice(0, HTML_EXCERPT_CHARS) }
          : {}),
      });
    }
    return examples;
  };

  return async (input, ctx) => {
    // A function, not a property read: the flag can flip while the shared computation is awaited below.
    const aborted = (): boolean => ctx?.signal?.aborted === true;
    if (limit === 0 || aborted()) return [];
    const tenant = input?.tenant != null && input.tenant !== "" ? input.tenant : undefined;
    const key = tenant ?? "";
    const at = clock();
    let entry = ttlMs > 0 ? memo.get(key) : undefined;
    if (entry == null || at - entry.at >= ttlMs) {
      const fresh = { at, result: compute(tenant) };
      entry = fresh;
      if (ttlMs > 0) {
        for (const [k, v] of memo) if (at - v.at >= ttlMs) memo.delete(k);
        memo.set(key, fresh);
        // A failed computation must not be served again for the rest of the TTL.
        fresh.result.catch(() => {
          if (memo.get(key) === fresh) memo.delete(key);
        });
      }
    }
    const result = await entry.result;
    if (aborted()) return [];
    return [...result];
  };
}
