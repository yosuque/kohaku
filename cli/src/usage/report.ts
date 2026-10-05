import type { UsageExportResult } from "./export.js";

/**
 * What `kohaku usage export` emits for a finished export. With `--out` (`result.outPath` set) it is the
 * one-line notice for stderr, WITHOUT a trailing newline (`console.error` adds it); without `--out` it is the
 * rendered CSV / JSON `result.text` for stdout, already newline-terminated and written as is. The caller picks
 * the stream by `result.outPath`, so stdout carries only the data.
 */
export function formatUsageExportResult(result: UsageExportResult): string {
  return result.outPath != null
    ? `Wrote ${result.rows.length} usage row(s) to ${result.outPath}`
    : result.text;
}
