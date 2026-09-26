import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAGE_PAGE_SIZE,
  decodeSeqCursor,
  encodeSeqCursor,
  LineageCursorError,
  MAX_LINEAGE_PAGE_SIZE,
  pageLineageArray,
} from "../src/lineage-page.js";
import type { LineageEventRecord } from "../src/ports.js";

/** Builds a base64url string from an arbitrary JSON value, bypassing encodeSeqCursor's {v,seq} shape --
 * used only to construct malformed-but-valid-base64url cursors for the decode-failure tests below.
 * Environment-neutral like the module under test (structural typing over globalThis; see lineage-page.ts). */
function toBase64UrlJson(value: unknown): string {
  const { btoa } = globalThis as unknown as { btoa(data: string): string };
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function event(
  type: string,
  payload: Record<string, unknown>,
  ts: string,
  tenant?: string,
): LineageEventRecord {
  return {
    id: `${type}:${ts}:${tenant ?? ""}`,
    ts,
    actor: { kind: "system" },
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

describe("encodeSeqCursor / decodeSeqCursor", () => {
  it("round-trips a seq value", () => {
    expect(decodeSeqCursor(encodeSeqCursor(0))).toBe(0);
    expect(decodeSeqCursor(encodeSeqCursor(1))).toBe(1);
    expect(decodeSeqCursor(encodeSeqCursor(123456789))).toBe(123456789);
  });

  it("produces a base64url string (no +, /, or = padding)", () => {
    const cursor = encodeSeqCursor(999999);
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it("throws LineageCursorError for a malformed cursor", () => {
    expect(() => decodeSeqCursor("not-base64url-json")).toThrow(LineageCursorError);
    expect(() => decodeSeqCursor("")).toThrow(LineageCursorError);
    // Valid base64url, but not the {v,seq} shape.
    expect(() => decodeSeqCursor(toBase64UrlJson({ foo: "bar" }))).toThrow(LineageCursorError);
    // Valid shape but an unsupported version.
    expect(() => decodeSeqCursor(toBase64UrlJson({ v: 2, seq: 1 }))).toThrow(LineageCursorError);
    // seq is not a number.
    expect(() => decodeSeqCursor(toBase64UrlJson({ v: 1, seq: "1" }))).toThrow(LineageCursorError);
  });
});

describe("pageLineageArray", () => {
  const events = Array.from({ length: 5 }, (_, i) =>
    event("view.composed", { intentHash: `h${i + 1}` }, `2026-01-0${i + 1}T00:00:00.000Z`),
  );

  it("returns everything in one page when pageSize is not exceeded, with no nextCursor", () => {
    const page = pageLineageArray(events, {});
    expect(page.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(page.nextCursor).toBeUndefined();
  });

  it("defaults pageSize to DEFAULT_LINEAGE_PAGE_SIZE and clamps above MAX_LINEAGE_PAGE_SIZE", () => {
    expect(DEFAULT_LINEAGE_PAGE_SIZE).toBe(500);
    expect(MAX_LINEAGE_PAGE_SIZE).toBe(1000);
    const page = pageLineageArray(events, { pageSize: 1_000_000 });
    expect(page.events).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it("pages forward in ascending append order with no gaps or duplicates", () => {
    const page1 = pageLineageArray(events, { pageSize: 2 });
    expect(page1.events.map((e) => e.id)).toEqual([events[0]!.id, events[1]!.id]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = pageLineageArray(events, { pageSize: 2, cursor: page1.nextCursor });
    expect(page2.events.map((e) => e.id)).toEqual([events[2]!.id, events[3]!.id]);
    expect(page2.nextCursor).toBeDefined();

    const page3 = pageLineageArray(events, { pageSize: 2, cursor: page2.nextCursor });
    expect(page3.events.map((e) => e.id)).toEqual([events[4]!.id]);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("an append between pages is visible on the next page without disturbing earlier ones", () => {
    const mutable = [...events];
    const page1 = pageLineageArray(mutable, { pageSize: 3 });
    expect(page1.events).toHaveLength(3);
    mutable.push(event("view.composed", { intentHash: "h6" }, "2026-01-06T00:00:00.000Z"));
    const page2 = pageLineageArray(mutable, { pageSize: 3, cursor: page1.nextCursor });
    expect(page2.events.map((e) => e.id)).toEqual([mutable[3]!.id, mutable[4]!.id, mutable[5]!.id]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("combines with a filter (correlationId) and skips non-matching events without breaking cursor progress", () => {
    const mixed = [
      event("view.composed", { correlationId: "c1" }, "2026-01-01T00:00:00.000Z"),
      event("view.composed", { correlationId: "other" }, "2026-01-02T00:00:00.000Z"),
      event("view.composed", { correlationId: "c1" }, "2026-01-03T00:00:00.000Z"),
      event("view.composed", { correlationId: "other" }, "2026-01-04T00:00:00.000Z"),
      event("view.composed", { correlationId: "c1" }, "2026-01-05T00:00:00.000Z"),
    ];
    const page1 = pageLineageArray(mixed, { correlationId: "c1", pageSize: 2 });
    expect(page1.events.map((e) => e.id)).toEqual([mixed[0]!.id, mixed[2]!.id]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = pageLineageArray(mixed, { correlationId: "c1", pageSize: 2, cursor: page1.nextCursor });
    expect(page2.events.map((e) => e.id)).toEqual([mixed[4]!.id]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("combines with a tenant filter", () => {
    const mixed = [
      event("view.composed", {}, "2026-01-01T00:00:00.000Z", "t1"),
      event("view.composed", {}, "2026-01-02T00:00:00.000Z", "t2"),
      event("view.composed", {}, "2026-01-03T00:00:00.000Z", "t1"),
    ];
    const page = pageLineageArray(mixed, { tenant: "t1" });
    expect(page.events.map((e) => e.id)).toEqual([mixed[0]!.id, mixed[2]!.id]);
  });

  it("clamps a pageSize <= 0 up to 1 (a page must always be able to make cursor progress)", () => {
    const page1 = pageLineageArray(events, { pageSize: 0 });
    expect(page1.events).toHaveLength(1);
    expect(page1.events[0]!.id).toBe(events[0]!.id);
    expect(page1.nextCursor).toBeDefined();
    // The cursor must have advanced, or a caller looping on nextCursor would spin forever.
    expect(page1.nextCursor).not.toBe(encodeSeqCursor(0));
  });

  it("throws for a malformed cursor instead of restarting or skipping silently", () => {
    expect(() => pageLineageArray(events, { cursor: "garbage" })).toThrow(LineageCursorError);
  });
});
