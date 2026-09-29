/**
 * Forward (append-order) paging over the lineage log (design.md #53): the opaque `seq` cursor codec
 * shared by every `StoragePort.pageLineage` implementation, plus `pageLineageArray`, a ready-made
 * implementation for an adapter that keeps its lineage log as a plain in-memory, append-ordered array
 * (storage-memory's `createMemoryStoragePort` / `createFileStoragePort`).
 *
 * Environment-neutral (no DOM lib / @types/node dependency), like the rest of spec-core: `btoa` / `atob`
 * are ECMAScript globals present in every environment (Node 18+, every modern browser), reached via
 * structural typing over `globalThis` (the same idiom `canonical-json.ts` uses for `TextEncoder` /
 * `crypto.subtle`). A cursor's decoded JSON is always plain ASCII (`{"v":1,"seq":<number>}`), so `btoa` /
 * `atob` (which operate on Latin1 "binary strings") need no UTF-8 byte-level handling here.
 */

import { matchesLineageFilter } from "./lineage-filter.js";
import type { LineageEventRecord, LineageFilter, LineagePage, LineagePageRequest } from "./ports.js";

/** `LineagePageRequest.pageSize`'s default when omitted. */
export const DEFAULT_LINEAGE_PAGE_SIZE = 500;

/** The upper bound `LineagePageRequest.pageSize` is clamped to (an oversized request is truncated, not rejected). */
export const MAX_LINEAGE_PAGE_SIZE = 1000;

/**
 * The effective page size for a `LineagePageRequest.pageSize`: `DEFAULT_LINEAGE_PAGE_SIZE` when omitted
 * (or not a number), otherwise floored to an integer and clamped to `[1, MAX_LINEAGE_PAGE_SIZE]`. The
 * floor at 1 means a page always advances its own cursor; the integer floor keeps a fractional request
 * (`2.5`) from reaching a SQL `LIMIT` or a count comparison as a non-integer. Every adapter's
 * `pageLineage` calls this instead of clamping on its own.
 */
export function clampLineagePageSize(pageSize?: number): number {
  if (pageSize == null || Number.isNaN(pageSize)) return DEFAULT_LINEAGE_PAGE_SIZE;
  return Math.max(1, Math.min(Math.floor(pageSize), MAX_LINEAGE_PAGE_SIZE));
}

/** Thrown by `decodeSeqCursor` when a cursor string is not one this codec produced. */
export class LineageCursorError extends Error {
  constructor(cursor: string, reason: string) {
    super(`invalid lineage cursor "${cursor}": ${reason}`);
    this.name = "LineageCursorError";
  }
}

interface SeqCursor {
  v: 1;
  seq: number;
}

const runtime = globalThis as unknown as {
  btoa(data: string): string;
  atob(data: string): string;
};

function toBase64Url(input: string): string {
  return runtime.btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return runtime.atob(padded + "=".repeat(padLength));
}

/**
 * Encodes a `seq` (an adapter-defined, monotonically increasing append-order position — a Postgres
 * `bigserial`, a Redis `INCR` counter, or a 1-based array/line index) as the opaque cursor string
 * `LineagePage.nextCursor` / `LineagePageRequest.cursor` carry on the wire. The wire format
 * (`{v:1,seq}`, base64url) is shared byte-for-byte with the Python port so a cursor produced by one
 * language's host is a valid `cursor` to the other's.
 */
export function encodeSeqCursor(seq: number): string {
  const payload: SeqCursor = { v: 1, seq };
  return toBase64Url(JSON.stringify(payload));
}

/** Decodes a cursor produced by `encodeSeqCursor`. Throws `LineageCursorError` for anything else
 * (malformed base64url, invalid JSON, wrong shape, an unsupported `v`, or a `seq` that is not a
 * non-negative safe integer — every real seq is a list index / line number / bigserial / INCR counter). */
export function decodeSeqCursor(cursor: string): number {
  let raw: string;
  try {
    raw = fromBase64Url(cursor);
  } catch {
    throw new LineageCursorError(cursor, "not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LineageCursorError(cursor, "does not decode to JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { seq?: unknown }).seq !== "number" ||
    !Number.isSafeInteger((parsed as { seq: number }).seq) ||
    (parsed as { seq: number }).seq < 0
  ) {
    throw new LineageCursorError(cursor, 'expected {"v":1,"seq":<non-negative integer>}');
  }
  return (parsed as SeqCursor).seq;
}

/**
 * `StoragePort.pageLineage` for an adapter that already keeps its whole lineage log as a plain
 * append-ordered array (`events`, oldest first — exactly what `createMemoryStoragePort` /
 * `createFileStoragePort` hold in memory). `seq` is taken to be 1-based position in that array (the
 * file-backed port's `seq` is by construction its `lineage.jsonl` line number, since every append pushes
 * to the file and the array in lockstep and a restart reloads the array in file order).
 *
 * Scans forward from `req.cursor` (or the start), applying every `LineageFilter` predicate `req` carries
 * via `matchesLineageFilter`, and collects up to `pageSize` matches (default `DEFAULT_LINEAGE_PAGE_SIZE`,
 * clamped to `MAX_LINEAGE_PAGE_SIZE` by `clampLineagePageSize`; also floored at 1 so a `pageSize` of 0 or less can never produce a
 * page whose `nextCursor` fails to advance, which would otherwise strand a caller looping via
 * `nextCursor` on the same cursor forever). `nextCursor` is set to the last returned event's own `seq`
 * only when at least one further match exists beyond the page (detected by scanning one match past
 * `pageSize` before trimming) — so the last page always omits it, matching the contract.
 */
export function pageLineageArray(
  events: readonly LineageEventRecord[],
  req: LineagePageRequest,
): LineagePage {
  const pageSize = clampLineagePageSize(req.pageSize);
  const afterSeq = req.cursor != null ? decodeSeqCursor(req.cursor) : 0;
  // `req` carries every LineageFilter predicate except `limit` (LineagePageRequest's definition), so it
  // is passed to matchesLineageFilter as-is; the extra `cursor` / `pageSize` fields are simply ignored by it.
  const filter: LineageFilter = req;

  const matches: LineageEventRecord[] = [];
  let lastSeq = afterSeq;
  let hasMore = false;
  for (let i = afterSeq; i < events.length; i++) {
    const event = events[i]!;
    if (!matchesLineageFilter(event, filter)) continue;
    if (matches.length === pageSize) {
      hasMore = true;
      break;
    }
    matches.push(event);
    lastSeq = i + 1;
  }
  return hasMore ? { events: matches, nextCursor: encodeSeqCursor(lastSeq) } : { events: matches };
}
