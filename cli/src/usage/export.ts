import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createKohakuClient, type Transport } from "@kohaku-ui/client";
import { mergeUsageRows, summarizeUsage, type UsageRow } from "@kohaku-ui/lineage";
import type { LineageEventRecord, StoragePort } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { parseHeaderArgs } from "../header-args.js";
import { CliUsageError, resolveRestTenant, resolveWindow } from "../lineage-window.js";
import { formatUsageCsv } from "./csv.js";

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
  /** Transport override (no CLI flag; REST mode tests inject an in-process Hono app's `app.request`). */
  transport?: Transport;
  /** StoragePort override for `--data-dir` mode (no CLI flag; tests inject one to exercise the paging guard). */
  storage?: StoragePort;
}

export interface UsageExportResult {
  rows: UsageRow[];
  /** The rendered output (CSV, or JSON of the `UsageRow[]`), newline-terminated. */
  text: string;
  /** The file written, when `out` was given. */
  outPath?: string;
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
 * `kohaku usage export`: derives per-day, per-tenant usage rows (design.md #74) from the **whole** lineage log
 * in the window -- exhaustive cursor paging, not the bounded sample behind GET /analytics/summary -- so the
 * numbers are suitable for metering. `--data-dir` pages a local StoragePort (the file layout of
 * `createFileStoragePort`; a Redis / Postgres deployment is read through `--rest`); `--rest` pages
 * GET /lineage through the client, which only ever sees the session's tenant. Each page is summarized as it
 * arrives and folded into the running rows (`mergeUsageRows`), so memory holds the rows, not the events.
 * Every bad argument is a `CliUsageError` (exit 2).
 */
export async function runUsageExport(opts: UsageExportOptions): Promise<UsageExportResult> {
  if (opts.dataDir == null && opts.rest == null) {
    throw new CliUsageError("Specify either --data-dir <dir> or --rest <baseUrl>");
  }
  if (opts.dataDir != null && opts.rest != null) {
    throw new CliUsageError("Specify only one of --data-dir or --rest, not both");
  }
  const format = opts.format ?? "csv";
  if (format !== "csv" && format !== "json") {
    throw new CliUsageError(`--format must be "csv" or "json", got "${String(format)}"`);
  }
  // Validated before any storage access: a bad window is a usage error (exit 2).
  const window = resolveWindow({ since: opts.since, until: opts.until });

  let pages: AsyncIterable<LineageEventRecord[]>;
  let tenantFilter: string | undefined;
  if (opts.dataDir != null) {
    // createFileStoragePort creates a missing directory, so a mistyped path would otherwise read as an empty
    // (and successful) export; stop at the door instead.
    if (!existsSync(opts.dataDir) || !statSync(opts.dataDir).isDirectory()) {
      throw new CliUsageError(`--data-dir ${opts.dataDir} is not an existing directory`);
    }
    tenantFilter = opts.tenant;
    pages = pagesOfStorage(opts.storage ?? createFileStoragePort(opts.dataDir), {
      type: USAGE_EVENT_TYPES,
      since: window.since,
      until: window.until,
      ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
    });
  } else {
    const headers = parseHeaderArgs(opts.headers);
    // The x-kohaku-tenant header is what actually scopes a REST request, so a --tenant that disagrees with
    // it (or has no header to back it) is rejected rather than mislabelled.
    resolveRestTenant(headers, opts.tenant);
    const client = createKohakuClient({
      baseUrl: opts.rest!.replace(/\/$/, ""),
      headers: () => headers,
      ...(opts.transport != null ? { transport: opts.transport } : {}),
    });
    pages = client.lineagePages({
      type: USAGE_EVENT_TYPES,
      since: window.since,
      until: window.until,
    });
  }

  let rows: UsageRow[] = [];
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
  const text = format === "json" ? `${JSON.stringify(rows, null, 2)}\n` : formatUsageCsv(rows);
  if (opts.out == null) return { rows, text };
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, text);
  return { rows, text, outPath: opts.out };
}
