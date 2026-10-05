import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createKohakuClient, globalTransport, type Transport } from "@kohaku-ui/client";
import { mergeUsageRows, summarizeUsage, type UsageRow } from "@kohaku-ui/lineage";
import type { LineageEventRecord, StoragePort } from "@kohaku-ui/spec-core";
import { parseHeaderArgs } from "../header-args.js";
import { CliUsageError, resolveRestTenant, resolveWindow } from "../lineage-window.js";
import { formatUsageCsv } from "./csv.js";
import { LINEAGE_FILE_NAME, type LineageFileScanStats, streamLineageChunks } from "./lineage-file.js";

/** The default per-request time limit of a `--rest` export, in milliseconds. */
export const DEFAULT_REST_TIMEOUT_MS = 30_000;

/** The lineage event types a usage summary reads (everything else is skipped at the source). */
const USAGE_EVENT_TYPES = ["view.composed", "intent.fixated", "intent.unfixated"];

export interface UsageExportOptions {
  /** Read from a local StoragePort data directory (mutually exclusive with `rest`). All tenants unless `tenant` is set. */
  dataDir?: string;
  /** Read over REST from a running host (mutually exclusive with `dataDir`). Only the session's tenant is visible. */
  rest?: string;
  /** Extra REST request headers ("name:value", repeatable) -- e.g. tenant / auth. REST mode only. */
  headers?: string[];
  tenant?: string;
  /** Lower bound: ISO 8601 date or timestamp; a date-only value starts that UTC day (see `resolveWindow`). */
  since: string;
  /** Upper bound: ISO 8601 date or timestamp; a date-only value INCLUDES that whole UTC day. */
  until: string;
  /** Output format. Default "csv". */
  format?: "csv" | "json";
  /** Write to this file instead of returning the text only (the caller prints it to stdout when omitted). */
  out?: string;
  /**
   * Time limit of each REST request (one page), in milliseconds; a request that takes longer fails the export
   * instead of hanging it. REST mode only. Default `DEFAULT_REST_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /** Transport override (no CLI flag; REST mode tests inject an in-process Hono app's `app.request`). */
  transport?: Transport;
  /**
   * A StoragePort the caller already holds (no CLI flag; a programmatic caller with a Redis / Postgres adapter,
   * or a test exercising the paging guard). Used in place of reading the `--data-dir` file, and paged with
   * `pageLineage`.
   */
  storage?: StoragePort;
  /** Where a warning goes (a malformed lineage line was skipped). Default: stderr. */
  warn?: (message: string) => void;
}

export interface UsageExportResult {
  rows: UsageRow[];
  /** The rendered output (CSV, or JSON of the `UsageRow[]`), newline-terminated. */
  text: string;
  /** The file written, when `out` was given. */
  outPath?: string;
  /** Lines of the `--data-dir` lineage file that were not a valid record and were skipped (0 otherwise). */
  skippedLines: number;
}

/** Every page of the lineage log matching the filter, via `pageLineage`'s cursor (refuses a cursor that does not advance). */
async function* pagesOfStorage(
  storage: StoragePort,
  filter: { type: string[]; since: string; until: string; tenant?: string },
): AsyncGenerator<LineageEventRecord[]> {
  const pageLineage = storage.pageLineage?.bind(storage);
  if (pageLineage == null) {
    throw new Error(
      "The StoragePort does not implement pageLineage; cannot read the lineage log exhaustively",
    );
  }
  let cursor: string | undefined;
  for (;;) {
    const page = await pageLineage({ ...filter, ...(cursor != null ? { cursor } : {}) });
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

/**
 * Gives every request of `base` its own time limit: a fresh `AbortSignal.timeout` per call, combined with any
 * signal the caller already set. `KohakuClient.lineagePages` takes one `RequestOptions.signal` for the whole
 * walk, which would cap the export as a whole rather than each page, so the limit goes on the transport.
 */
function withRequestTimeout(base: Transport, timeoutMs: number): Transport {
  return (url, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal != null ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(url, { ...init, signal });
  };
}

/**
 * Writes `text` to `path` through `<path>.tmp` and a rename, so a failed or interrupted export never leaves a
 * half-written file under the final name (a billing job reading it would take the truncated rows for the whole).
 */
function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Whether `error` is the abort an `AbortSignal.timeout` raises (fetch and `Response.json()` surface it as is or as a cause). */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || isTimeoutError(error.cause);
}

/**
 * `kohaku usage export`: derives per-day, per-tenant usage rows (design.md #74) from the **whole** lineage log
 * in the window -- exhaustive cursor paging, not the bounded sample behind GET /analytics/summary -- so the
 * numbers are suitable for metering. `--data-dir` streams the `lineage.jsonl` of a `createFileStoragePort`
 * directory line by line, in chunks of 500 matching events; it reads that one file and writes nothing (it
 * does not open the store, so a corrupt promotions.json is left alone). A Redis / Postgres deployment is read
 * through `--rest`, which pages GET /lineage through the client, scoped by the `x-kohaku-tenant` header (a host
 * without tenant scoping returns every tenant). Each chunk or page is summarized as it arrives and folded into
 * the running rows (`mergeUsageRows`), so memory holds the rows and one chunk, not the log.
 * Every bad argument is a `CliUsageError` (exit 2).
 */
export async function runUsageExport(opts: UsageExportOptions): Promise<UsageExportResult> {
  if (opts.dataDir == null && opts.rest == null) {
    throw new CliUsageError("Specify either --data-dir <dir> or --rest <baseUrl>");
  }
  if (opts.dataDir != null && opts.rest != null) {
    throw new CliUsageError("Specify only one of --data-dir or --rest, not both");
  }
  if (opts.tenant === "") {
    // A StoragePort reads an empty tenant as "no filter", so `--tenant ""` would not select the rows whose
    // tenant column is empty; it would export everything. Say so rather than export the wrong thing silently.
    throw new CliUsageError(
      '--tenant must not be empty: an empty tenant means "no tenant filter". Usage that carries no tenant ' +
        "(every compose through an MCP host, which resolves none) is part of the unfiltered export, as the " +
        "rows whose tenant column is empty",
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliUsageError(
      `--timeout-ms must be a positive integer (milliseconds), got "${String(timeoutMs)}"`,
    );
  }
  const format = opts.format ?? "csv";
  if (format !== "csv" && format !== "json") {
    throw new CliUsageError(`--format must be "csv" or "json", got "${String(format)}"`);
  }
  // Validated before any storage access: a bad window is a usage error (exit 2).
  const window = resolveWindow({ since: opts.since, until: opts.until });

  let pages: AsyncIterable<LineageEventRecord[]>;
  let tenantFilter: string | undefined;
  const scan: LineageFileScanStats = { skippedLines: 0 };
  const lineagePath = opts.dataDir != null ? join(opts.dataDir, LINEAGE_FILE_NAME) : "";
  if (opts.dataDir != null) {
    // A mistyped path would otherwise read as an empty (and successful) export; stop at the door instead.
    if (!existsSync(opts.dataDir) || !statSync(opts.dataDir).isDirectory()) {
      throw new CliUsageError(`--data-dir ${opts.dataDir} is not an existing directory`);
    }
    tenantFilter = opts.tenant;
    const filter = {
      type: USAGE_EVENT_TYPES,
      since: window.since,
      until: window.until,
      ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
    };
    pages =
      opts.storage != null
        ? pagesOfStorage(opts.storage, filter)
        : streamLineageChunks(lineagePath, filter, scan);
  } else {
    const headers = parseHeaderArgs(opts.headers);
    // The x-kohaku-tenant header is what actually scopes a REST request, so a --tenant that disagrees with
    // it (or has no header to back it) is rejected rather than mislabelled.
    resolveRestTenant(headers, opts.tenant);
    const client = createKohakuClient({
      baseUrl: opts.rest!.replace(/\/$/, ""),
      headers: () => headers,
      transport: withRequestTimeout(opts.transport ?? globalTransport(), timeoutMs),
    });
    pages = client.lineagePages({
      type: USAGE_EVENT_TYPES,
      since: window.since,
      until: window.until,
    });
  }

  let rows: UsageRow[] = [];
  try {
    for await (const page of pages) {
      rows = mergeUsageRows(
        rows,
        summarizeUsage(page, {
          bucket: "day",
          since: window.since,
          until: window.until,
          ...(tenantFilter != null ? { tenant: tenantFilter } : {}),
        }),
      );
    }
  } catch (e) {
    if (opts.rest != null && isTimeoutError(e)) {
      throw new Error(
        `A request to ${opts.rest} took longer than ${timeoutMs} ms and was abandoned; raise --timeout-ms ` +
          "if the host is just slow",
        { cause: e },
      );
    }
    throw e;
  }
  if (scan.skippedLines > 0) {
    const warn = opts.warn ?? ((message: string) => console.error(message));
    warn(
      `Skipped ${scan.skippedLines} malformed or invalid line(s) in ${lineagePath}; ` +
        "the export does not count them",
    );
  }
  const text = format === "json" ? `${JSON.stringify(rows, null, 2)}\n` : formatUsageCsv(rows);
  if (opts.out == null) return { rows, text, skippedLines: scan.skippedLines };
  writeAtomically(opts.out, text);
  return { rows, text, outPath: opts.out, skippedLines: scan.skippedLines };
}
