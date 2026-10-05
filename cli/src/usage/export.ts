import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createKohakuClient, type Transport } from "@kohaku-ui/client";
import { summarizeUsage, type UsageRow } from "@kohaku-ui/lineage";
import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { resolveRestTenant } from "../evidence/export.js";
import { EvidenceUsageError, resolveEvidenceWindow } from "../evidence/window.js";
import { parseHeaderArgs } from "../header-args.js";
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
  /** Lower bound: ISO 8601 date or timestamp; a date-only value starts that UTC day (see `resolveEvidenceWindow`). */
  since: string;
  /** Upper bound: ISO 8601 date or timestamp; a date-only value INCLUDES that whole UTC day. */
  until: string;
  /** Output format. Default "csv". */
  format?: "csv" | "json";
  /** Write to this file instead of returning the text only (the caller prints it to stdout when omitted). */
  out?: string;
  /** Transport override (no CLI flag; REST mode tests inject an in-process Hono app's `app.request`). */
  transport?: Transport;
}

export interface UsageExportResult {
  rows: UsageRow[];
  /** The rendered output (CSV, or JSON of the `UsageRow[]`), newline-terminated. */
  text: string;
  /** The file written, when `out` was given. */
  outPath?: string;
}

/**
 * `kohaku usage export`: derives per-day, per-tenant usage rows (design.md #74) from the **whole** lineage log
 * in the window -- exhaustive cursor paging, not the bounded sample behind GET /analytics/summary -- so the
 * numbers are suitable for metering. `--data-dir` pages a local StoragePort; `--rest` pages GET /lineage
 * through the client, which only ever sees the session's tenant.
 */
export async function runUsageExport(opts: UsageExportOptions): Promise<UsageExportResult> {
  if (opts.dataDir == null && opts.rest == null) {
    throw new Error("Specify either --data-dir <dir> or --rest <baseUrl>");
  }
  if (opts.dataDir != null && opts.rest != null) {
    throw new Error("Specify only one of --data-dir or --rest, not both");
  }
  const format = opts.format ?? "csv";
  if (format !== "csv" && format !== "json") {
    throw new EvidenceUsageError(`--format must be "csv" or "json", got "${String(format)}"`);
  }
  // Validated before any storage access: a bad window is a usage error (exit 2).
  const window = resolveEvidenceWindow({ since: opts.since, until: opts.until });

  const events: LineageEventRecord[] = [];
  let tenantFilter: string | undefined;
  if (opts.dataDir != null) {
    tenantFilter = opts.tenant;
    const storage = createFileStoragePort(opts.dataDir);
    const pageLineage = storage.pageLineage?.bind(storage);
    if (pageLineage == null) {
      throw new Error(
        "The StoragePort does not implement pageLineage; cannot read the lineage log exhaustively",
      );
    }
    let cursor: string | undefined;
    for (;;) {
      const page = await pageLineage({
        type: USAGE_EVENT_TYPES,
        since: window.since,
        until: window.until,
        ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
        ...(cursor != null ? { cursor } : {}),
      });
      events.push(...page.events);
      if (page.nextCursor == null) break;
      if (page.nextCursor === cursor) {
        throw new Error(
          "pageLineage returned the same nextCursor it was given; refusing to page forever " +
            "(a StoragePort must advance the cursor)",
        );
      }
      cursor = page.nextCursor;
    }
  } else {
    const headers = parseHeaderArgs(opts.headers);
    // Same rule as `evidence export --rest`: the x-kohaku-tenant header is what actually scopes the request,
    // so a --tenant that disagrees with it (or has no header to back it) is rejected rather than mislabelled.
    resolveRestTenant(headers, opts.tenant);
    const client = createKohakuClient({
      baseUrl: opts.rest!.replace(/\/$/, ""),
      headers: () => headers,
      ...(opts.transport != null ? { transport: opts.transport } : {}),
    });
    for await (const page of client.lineagePages({
      type: USAGE_EVENT_TYPES,
      since: window.since,
      until: window.until,
    })) {
      events.push(...page);
    }
  }

  const rows = summarizeUsage(events, {
    bucket: "day",
    since: window.since,
    until: window.until,
    ...(tenantFilter != null ? { tenant: tenantFilter } : {}),
  });
  const text = format === "json" ? `${JSON.stringify(rows, null, 2)}\n` : formatUsageCsv(rows);
  if (opts.out == null) return { rows, text };
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, text);
  return { rows, text, outPath: opts.out };
}
