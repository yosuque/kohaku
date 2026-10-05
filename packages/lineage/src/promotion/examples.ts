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
   * The tenant whose reviewer corrections may be reused. With no tenant, only records that carry **no** tenant
   * are read: a provider shared by every tenant (the extractor is built once per process) must not feed one
   * tenant's component HTML and naming into another tenant's prompt, and through the suggestion into its review
   * form. A single-tenant deployment (no record carries a tenant) is unaffected.
   */
  tenant?: string;
}

const DEFAULT_LIMIT = 2;
/** How many recent `component.schemaEdited` records are considered. */
const EDIT_SCAN_WINDOW = 200;
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
 * Read-only; a storage failure rejects, which the extractor treats as "no examples".
 */
export function schemaEditExamples(
  storage: StoragePort,
  opts: SchemaEditExamplesOptions = {},
): () => Promise<SchemaEditExample[]> {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const tenant = opts.tenant;
  const inScope = (e: LineageEventRecord): boolean =>
    tenant != null ? e.tenant === tenant : e.tenant == null;

  /** The latest in-scope event of `type` for the artifact (the log is in append order, so the last one). */
  async function latest(type: string, artifactId: string): Promise<LineageEventRecord | undefined> {
    const events = await storage.listLineage({
      type: [type],
      artifactId,
      limit: 50,
      ...(tenant != null ? { tenant } : {}),
    });
    return events.filter(inScope).at(-1);
  }

  return async () => {
    if (limit === 0) return [];
    const edits = (
      await storage.listLineage({
        type: ["component.schemaEdited"],
        limit: EDIT_SCAN_WINDOW,
        ...(tenant != null ? { tenant } : {}),
      })
    )
      .filter(inScope)
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

      const final = (await latest("component.schemaProposed", artifactId))?.payload["draft"];
      if (!isDraft(final)) continue;
      const suggested = (await latest("component.schemaSuggested", artifactId))?.payload["suggestion"];
      const suggestedDraft =
        suggested != null && typeof suggested === "object"
          ? (suggested as Record<string, unknown>)["draft"]
          : undefined;
      const html = (await latest("component.generated", artifactId))?.payload["html"];

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
