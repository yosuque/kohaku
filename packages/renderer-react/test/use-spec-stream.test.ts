import type { UISpec } from "@kohaku-ui/spec-core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type ComposeStreamWireEvent, readComposeStream, useSpecStream } from "../src/use-spec-stream.js";

// --- SSE wire assembly helpers -------------------------------------------------

/** Builds one SSE frame (event: / data: + the separating blank line). */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Builds a ReadableStream that emits string/byte chunks in order (for verifying chunk boundaries). */
function toStream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const parts = chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++]!);
      else controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<ComposeStreamWireEvent[]> {
  const out: ComposeStreamWireEvent[] = [];
  for await (const e of readComposeStream(body)) out.push(e);
  return out;
}

/** Minimal Response passed to a hook that only looks at res.ok / res.status / res.body. */
function fakeResponse(
  body: ReadableStream<Uint8Array>,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return { ok: init.ok ?? true, status: init.status ?? 200, body } as unknown as Response;
}

// --- Test Spec / Patch fixtures ----------------------------------------

const HASH = "sha256:" + "a".repeat(64);

/** A skeleton Spec containing ui.loading (a structure that passes safeParseSpec). */
function skeleton(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: HASH },
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["loading1"] },
      { id: "loading1", type: "ui.loading", props: {} },
    ],
    events: [],
    provenance: { tier: "L1", composedBy: "test", cache: "miss" },
  };
}

/** A patch that removes loading1 and swaps in the finalized component (h1). */
function finalPatch(): unknown {
  return {
    baseIntentHash: HASH,
    upsert: [
      { id: "root", type: "layout.stack", props: {}, children: ["h1"] },
      { id: "h1", type: "text.heading", props: { level: 2, text: "Finalized" } },
    ],
    remove: ["loading1"],
  };
}

describe("readComposeStream: SSE parser", () => {
  it("correctly splits spec → patch → done in a single chunk", async () => {
    const events = await collect(
      toStream([
        frame("spec", { spec: { a: 1 }, capability: "cap", final: false }),
        frame("patch", { patch: { baseIntentHash: HASH } }),
        frame("done", { specHash: "sha", tier: "L1", cache: "miss" }),
      ]),
    );

    expect(events.map((e) => e.kind)).toEqual(["spec", "patch", "done"]);
    const spec = events[0];
    if (spec.kind !== "spec") throw new Error("first is spec");
    expect(spec.spec).toEqual({ a: 1 });
    expect(spec.capability).toBe("cap");
    expect(spec.final).toBe(false);
    const done = events[2];
    if (done.kind !== "done") throw new Error("last is done");
    expect(done).toMatchObject({ specHash: "sha", tier: "L1", cache: "miss" });
  });

  it("yields the same event sequence even across chunk-split boundaries (mid-line, mid-multibyte)", async () => {
    const full =
      frame("spec", { spec: { label: "読み込み中" }, capability: "cap", final: false }) +
      frame("done", { specHash: "h", tier: "L1", cache: "miss" });
    const bytes = new TextEncoder().encode(full);
    // Split every 5 bytes (guaranteed to break mid-line and mid-Japanese-multibyte)
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) chunks.push(bytes.subarray(i, i + 5));

    const events = await collect(toStream(chunks));
    expect(events.map((e) => e.kind)).toEqual(["spec", "done"]);
    const spec = events[0];
    if (spec.kind !== "spec") throw new Error("first is spec");
    expect(spec.spec).toEqual({ label: "読み込み中" });
  });

  it("multi-line data is newline-joined before JSON.parse", async () => {
    const raw = 'event: error\ndata: {"error":\ndata: {"code":"X","message":"m"}}\n\n';
    const events = await collect(toStream([raw]));
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.kind !== "error") throw new Error("error event");
    expect(ev.error).toEqual({ code: "X", message: "m" });
  });

  it("comment lines and unknown events are ignored", async () => {
    const raw =
      ": keep-alive\n" + "event: heartbeat\ndata: {}\n\n" + frame("spec", { spec: { a: 1 }, final: true });
    const events = await collect(toStream([raw]));
    expect(events.map((e) => e.kind)).toEqual(["spec"]);
    const spec = events[0];
    if (spec.kind !== "spec") throw new Error("spec");
    expect(spec.final).toBe(true);
    expect(spec.capability).toBeUndefined();
  });

  it("unknown events are ignored without parsing data (no data / non-JSON data does not break the stream)", async () => {
    // The old implementation JSON.parse(data)'d before deciding the event name, so an unknown event with no data (JSON.parse("")) or
    // non-JSON data would throw and drop the whole stream. The contract is "ignore unknown events."
    const raw =
      "event: ping\n\n" + // no data line → the old implementation throws on JSON.parse("")
      "event: noise\ndata: not-json\n\n" + // an unknown event with non-JSON data
      frame("spec", { spec: { a: 1 }, final: true }) +
      frame("done", { specHash: "h", tier: "L1", cache: "miss" });
    const events = await collect(toStream([raw]));
    expect(events.map((e) => e.kind)).toEqual(["spec", "done"]);
  });
});

describe("useSpecStream: consumer hook", () => {
  it("spec (skeleton) → patch → done folds into the final form with phase:done", async () => {
    const stream = toStream([
      frame("spec", { spec: skeleton(), capability: "cap-1", final: false }),
      frame("patch", { patch: finalPatch() }),
      frame("done", { specHash: "sha256:final", tier: "L1", cache: "miss" }),
    ]);
    const { result } = renderHook(() => useSpecStream());
    expect(result.current.phase).toBe("idle");

    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.capability).toBe("cap-1");
    expect(result.current.specHash).toBe("sha256:final");
    // The finalized form after folding the patch (loading1 disappears and is swapped with h1)
    expect(result.current.spec?.components.map((c) => c.id)).toEqual(["root", "h1"]);
  });

  it("the stream completes even with unknown events interleaved (no data / non-JSON) (phase:done)", async () => {
    const stream = toStream([
      "event: ping\n\n",
      frame("spec", { spec: skeleton(), capability: "cap-1", final: false }),
      "event: noise\ndata: not-json\n\n",
      frame("patch", { patch: finalPatch() }),
      frame("done", { specHash: "sha256:final", tier: "L1", cache: "miss" }),
    ]);
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.spec?.components.map((c) => c.id)).toEqual(["root", "h1"]);
  });

  it("an invalid patch is phase:error (PATCH_INVALID)", async () => {
    const stream = toStream([
      frame("spec", { spec: skeleton(), capability: "cap-1", final: false }),
      frame("patch", { patch: { notAPatch: true } }), // fails zod due to missing baseIntentHash
      frame("done", { specHash: "sha256:x", tier: "L1", cache: "miss" }),
    ]);
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("PATCH_INVALID");
  });

  it("an error event is reflected as-is into phase:error", async () => {
    const stream = toStream([
      frame("error", { error: { code: "COMPOSE_FAILED", message: "generation failed" } }),
    ]);
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toEqual({ code: "COMPOSE_FAILED", message: "generation failed" });
  });

  it("a non-200 HTTP is phase:error (STREAM_HTTP)", async () => {
    const { result } = renderHook(() => useSpecStream());
    const stream = toStream([":\n\n"]);
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream, { ok: false, status: 500 }))));
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("STREAM_HTTP");
  });

  it("CRLF line endings are handled the same as LF (spec -> done)", async () => {
    const raw =
      frame("spec", { spec: skeleton(), capability: "cap-1", final: true }).replace(/\n/g, "\r\n") +
      frame("done", { specHash: "sha256:x", tier: "L1", cache: "miss" }).replace(/\n/g, "\r\n");
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(toStream([raw])))));

    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.capability).toBe("cap-1");
    expect(result.current.spec?.components.map((c) => c.id)).toEqual(["root", "loading1"]);
  });

  it("an invalid spec is phase:error (SPEC_INVALID)", async () => {
    const stream = toStream([frame("spec", { spec: { not: "a valid spec" }, final: false })]);
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("SPEC_INVALID");
  });

  it("a patch received before any spec is phase:error (PATCH_WITHOUT_SPEC)", async () => {
    const stream = toStream([frame("patch", { patch: finalPatch() })]);
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("PATCH_WITHOUT_SPEC");
  });

  it("a well-formed but structurally invalid patch (dangling child reference) is phase:error (PATCH_APPLY_FAILED)", async () => {
    // Removing loading1 without also removing it from root's children leaves a dangling reference,
    // which fails structural validation inside applyPatch (SpecError PATCH_APPLY_FAILED).
    const stream = toStream([
      frame("spec", { spec: skeleton(), capability: "cap-1", final: false }),
      frame("patch", { patch: { baseIntentHash: HASH, remove: ["loading1"] } }),
    ]);
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("PATCH_APPLY_FAILED");
  });

  it("the stream closes without a done or error event → phase:error (STREAM_INCOMPLETE)", async () => {
    // Cut the stream off right after a spec frame (no trailing done/error), simulating a truncated response.
    const stream = toStream([frame("spec", { spec: skeleton(), capability: "cap-1", final: false })]);
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(stream))));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("STREAM_INCOMPLETE");
  });

  it("the request body throwing mid-read is phase:error (STREAM_FAILED)", async () => {
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame("spec", { spec: skeleton(), final: false })));
      },
      pull() {
        throw new Error("network dropped");
      },
    });
    const { result } = renderHook(() => useSpecStream());
    act(() => result.current.start(() => Promise.resolve(fakeResponse(failingBody))));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("STREAM_FAILED");
    expect(result.current.error?.message).toContain("network dropped");
  });

  it("unmounting before the response resolves cancels the now-stale response body instead of reading it", async () => {
    // request() only resolves after unmount, so the hook's `alive()` check (bumped by the unmount cleanup
    // effect) must be what triggers the cancel — reading the stream never gets a chance to run.
    let resolveRequest!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Never closes or errors; if this were read, the test would hang instead of resolving via cancel().
      },
      cancel() {
        cancelled = true;
      },
    });
    const { result, unmount } = renderHook(() => useSpecStream());
    act(() => {
      result.current.start(() => pending);
    });

    unmount();
    resolveRequest(fakeResponse(body));

    await waitFor(() => expect(cancelled).toBe(true));
  });
});
