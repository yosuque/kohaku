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
/** How many recent records of each event type are considered (one query per type). */
const SCAN_WINDOW = 200;
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
 * Four storage reads per call (one per event type, the newest 200 records of each, all with the same tenant
 * condition), joined in memory by `artifactId`: a case whose proposal or HTML has scrolled out of that window is
 * skipped or loses its optional parts rather than costing another query. Read-only; a storage failure
 * rejects, which the extractor treats as "no examples". The `signal` the extractor passes is only checked
 * between steps: the extractor stops waiting for a slow provider on its own when its budget is spent.
 */
export function schemaEditExamples(
  storage: StoragePort,
  opts: SchemaEditExamplesOptions = {},
): (
  input: SchemaEditExamplesInput,
  ctx?: { signal?: { readonly aborted: boolean } },
) => Promise<SchemaEditExample[]> {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));

  return async (input, ctx) => {
    if (limit === 0) return [];
    const tenant = input?.tenant != null && input.tenant !== "" ? input.tenant : undefined;
    // With a tenant the storage already narrows to it; the exact-match check only guards an adapter that
    // ignores the filter. Without one, "no tenant" means both an absent field and an empty string.
    const inScope = (e: LineageEventRecord): boolean =>
      tenant != null ? e.tenant === tenant : e.tenant == null || e.tenant === "";
    const read = async (type: string): Promise<LineageEventRecord[]> =>
      (
        await storage.listLineage({
          type: [type],
          limit: SCAN_WINDOW,
          ...(tenant != null ? { tenant } : {}),
        })
      ).filter(inScope);

    const [editedAll, proposed, suggested, generated] = await Promise.all([
      read("component.schemaEdited"),
      read("component.schemaProposed"),
      read("component.schemaSuggested"),
      read("component.generated"),
    ]);
    if (ctx?.signal?.aborted === true) return [];

    /** artifactId -> payload field of the latest event (the log is in append order, so the last one wins). */
    const latestBy = (events: LineageEventRecord[], field: string): Map<string, unknown> => {
      const byArtifact = new Map<string, unknown>();
      for (const event of events) {
        const artifactId = event.payload["artifactId"];
        if (typeof artifactId === "string") byArtifact.set(artifactId, event.payload[field]);
      }
      return byArtifact;
    };
    const finals = latestBy(proposed, "draft");
    const suggestions = latestBy(suggested, "suggestion");
    const htmls = latestBy(generated, "html");

    const edits = editedAll
      .map((event, index) => ({ event, index }))
      // Newest first: by timestamp, and for equal timestamps the later append wins.
      .sort((a, b) => (a.event.ts === b.event.ts ? b.index - a.index : a.event.ts < b.event.ts ? 1 : -1))
      .map(({ event }) => event);

    const examples: SchemaEditExample[] = [];
    const seen = new Set<string>();
    for (const edit of edits) {
      if (examples.length >= limit) break;
      const changed = edit.payload["changed"];
      const artifactId = edit.payload["artifactId"];
      if (!Array.isArray(changed) || changed.length === 0) continue;
      if (typeof artifactId !== "string" || artifactId === "" || seen.has(artifactId)) continue;
      seen.add(artifactId);

      const final = finals.get(artifactId);
      if (!isDraft(final)) continue;
      const suggestion = suggestions.get(artifactId);
      const suggestedDraft =
        suggestion != null && typeof suggestion === "object"
          ? (suggestion as Record<string, unknown>)["draft"]
          : undefined;
      const html = htmls.get(artifactId);

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
}
