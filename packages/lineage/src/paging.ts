import type { LineageEventRecord, LineagePage, LineagePageRequest } from "@kohaku-ui/spec-core";

/** Anything that can serve `StoragePort.pageLineage`'s contract (a StoragePort, or an `EvidenceSource`). */
export interface LineagePageSource {
  pageLineage(req: LineagePageRequest): Promise<LineagePage>;
}

/**
 * Walks the whole lineage log matching `request` through a source's `pageLineage`, yielding one page's events
 * per iteration (a page may be short or even empty and still have a `nextCursor`, so the walk follows the
 * cursor until it is absent, whatever a page holds). The shared cursor loop behind the evidence pack and the
 * usage export, so the "a cursor that does not advance is refused" guard exists once.
 *
 * `request.cursor` is not accepted: the walk always starts from the beginning. Throws, after yielding the
 * page that carried it, when a page returns the same `nextCursor` it was given: a source that does not advance
 * its cursor would otherwise be paged forever.
 */
export async function* iterateLineagePages(
  source: LineagePageSource,
  request: Omit<LineagePageRequest, "cursor">,
): AsyncGenerator<LineageEventRecord[], void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await source.pageLineage({ ...request, ...(cursor != null ? { cursor } : {}) });
    yield page.events;
    if (page.nextCursor == null) return;
    if (page.nextCursor === cursor) {
      throw new Error(
        "pageLineage returned the same nextCursor it was given; refusing to page forever " +
          "(a StoragePort must advance the cursor)",
      );
    }
    cursor = page.nextCursor;
  }
}
