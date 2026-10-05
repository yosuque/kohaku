import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  type LineageEventRecord,
  LineageEventRecordSchema,
  matchesLineageFilter,
} from "@kohaku-ui/spec-core";

/**
 * The lineage file inside a `createFileStoragePort` data directory (see
 * packages/storage-memory/src/file-storage-port.ts, which appends one JSON record per line).
 */
export const LINEAGE_FILE_NAME = "lineage.jsonl";

/** How many matching events one chunk holds: the most `kohaku usage export --data-dir` keeps in memory at once. */
export const USAGE_CHUNK_SIZE = 500;

/** What a scan of the lineage file skipped (filled in while the generator runs; complete once it is done). */
export interface LineageFileScanStats {
  /** Lines that are not valid JSON or not a `LineageEventRecord` (a hand-edited line, or one cut off by a crash). */
  skippedLines: number;
}

/**
 * Streams a `lineage.jsonl` file line by line and yields the records that match `filter` in chunks of at most
 * `chunkSize`, so a whole log is never held in memory. Read-only: it opens the one file for reading and never
 * touches anything else in the directory (unlike `createFileStoragePort`, which loads every file at startup
 * and moves a corrupt snapshot aside).
 *
 * A blank line is ignored. A line that is not JSON, or is JSON but not a `LineageEventRecord`, is counted in
 * `stats.skippedLines` and skipped, the same warn-and-skip rule `createFileStoragePort` applies when it
 * loads the file. A missing file is an empty log. The filter is spec-core's `matchesLineageFilter`, so type,
 * tenant (an empty tenant is no filter) and the inclusive since / until bounds read exactly as they do
 * for a StoragePort.
 */
export async function* streamLineageChunks(
  path: string,
  filter: { type: readonly string[]; since: string; until: string; tenant?: string },
  stats: LineageFileScanStats,
  chunkSize: number = USAGE_CHUNK_SIZE,
): AsyncGenerator<LineageEventRecord[]> {
  if (!existsSync(path)) return;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let chunk: LineageEventRecord[] = [];
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        stats.skippedLines++;
        continue;
      }
      const record = LineageEventRecordSchema.safeParse(parsed);
      if (!record.success) {
        stats.skippedLines++;
        continue;
      }
      const event = record.data as LineageEventRecord;
      if (
        !matchesLineageFilter(event, {
          type: [...filter.type],
          since: filter.since,
          until: filter.until,
          ...(filter.tenant != null ? { tenant: filter.tenant } : {}),
        })
      ) {
        continue;
      }
      chunk.push(event);
      if (chunk.length >= chunkSize) {
        yield chunk;
        chunk = [];
      }
    }
    if (chunk.length > 0) yield chunk;
  } finally {
    lines.close();
  }
}
