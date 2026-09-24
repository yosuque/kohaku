import { createKohakuClient, KohakuHostError } from "@kohaku-ui/client";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  AdminProvider,
  defaultAdminMessages,
  useAnalyticsSummary,
  useLineage,
  usePromotions,
} from "../src/index.js";
import { jsonResponse, type Notice, stubClient } from "./helpers.js";

/** A Promise you can resolve from outside, for controlling exactly when a fetch "arrives". */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function wrapperFor(handlers: Parameters<typeof stubClient>[0], notices: Notice[]) {
  const { client, calls } = stubClient(handlers);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AdminProvider client={client} onNotice={(text, kind) => notices.push({ text, kind })}>
      {children}
    </AdminProvider>
  );
  return { wrapper, calls };
}

describe("data hooks", () => {
  it("useLineage loads the newest-first event list through client.lineage", async () => {
    const notices: Notice[] = [];
    const events = [
      { id: "1", ts: "2026-01-01T00:00:00Z", type: "view.composed", actor: { kind: "system" }, payload: {} },
      { id: "2", ts: "2026-01-01T00:00:01Z", type: "view.rendered", actor: { kind: "system" }, payload: {} },
    ];
    const { wrapper, calls } = wrapperFor({ "GET /lineage": () => jsonResponse({ events }) }, notices);
    const { result } = renderHook(() => useLineage({ limit: 120 }), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((e) => e.id)).toEqual(["2", "1"]);
    expect(calls[0]!.url).toBe("/api/kohaku/lineage?limit=120");
  });

  it("useAnalyticsSummary notifies the denied message on 403 and keeps data null", async () => {
    const notices: Notice[] = [];
    const { wrapper } = wrapperFor(
      {
        "GET /analytics/summary": () =>
          jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
      },
      notices,
    );
    const { result } = renderHook(() => useAnalyticsSummary(), { wrapper });
    await waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toEqual({
      text: defaultAdminMessages.deniedMessage("CAPABILITY_DENIED", defaultAdminMessages.analytics.opRead),
      kind: "error",
    });
    expect(result.current.data).toBeNull();
  });

  it("usePromotions evaluates for 'all' and lists for a specific status", async () => {
    const notices: Notice[] = [];
    const cand = {
      artifactId: "a@1",
      status: "candidate",
      uses: 3,
      sessions: 2,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const { wrapper, calls } = wrapperFor(
      {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "GET /promotions": () => jsonResponse({ candidates: [] }),
      },
      notices,
    );
    const { result, rerender } = renderHook(({ status }: { status: string }) => usePromotions(status), {
      wrapper,
      initialProps: { status: "all" },
    });
    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.promotionMinUses).toBe(2);
    rerender({ status: "published" });
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/kohaku/promotions?status=published"))).toBe(true),
    );
    await waitFor(() => expect(result.current.candidates).toHaveLength(0));
    void KohakuHostError;
  });
});

/**
 * Direct coverage of `useResultGuard()` (hooks.ts), the highest-risk code from Task 3: it has no test of its
 * own anywhere, and every data hook in this file depends on it silently doing the right thing. Both guarantees
 * are exercised through a real hook (not by reaching into the private function) via an externally-controlled
 * ("deferred") response, so each half fails for real if `guard()`'s corresponding check is deleted.
 */
describe("useResultGuard (the mount/staleness guard behind every data hook)", () => {
  it("writes no state, and fires no notice, for a response that resolves after the component unmounts", async () => {
    const pending = deferred<Response>();
    const notices: Notice[] = [];
    const client = createKohakuClient({
      baseUrl: "/api/kohaku",
      transport: async (url) => {
        if (url.includes("/analytics/summary")) return pending.promise;
        throw new Error(`unexpected fetch: ${url}`);
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AdminProvider client={client} onNotice={(text, kind) => notices.push({ text, kind })}>
        {children}
      </AdminProvider>
    );
    const { result, unmount } = renderHook(() => useAnalyticsSummary(), { wrapper });
    unmount();
    // The request "arrives" only after the component is gone: a 403 here would otherwise make the hook's
    // .catch call `notify(...)` and `setData(null)` — both must be suppressed by `mountedRef`, not merely by
    // React's own no-op-after-unmount handling of the state write. `notify` reaches `notices` through a plain
    // callback ref, not React state, so it is NOT protected by React itself — only by the guard checked here.
    pending.resolve(jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403));
    await new Promise((r) => setTimeout(r, 0));
    expect(notices).toEqual([]);
    expect(result.current.data).toBeNull();
  });

  it("keeps a newer reload()'s result even when an older, superseded reload resolves later", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const responses = [first.promise, second.promise];
    let call = 0;
    const client = createKohakuClient({
      baseUrl: "/api/kohaku",
      transport: async (url) => {
        if (url.includes("/lineage")) return responses[call++]!;
        throw new Error(`unexpected fetch: ${url}`);
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AdminProvider client={client}>{children}</AdminProvider>
    );
    const { result } = renderHook(() => useLineage({ limit: 5 }), { wrapper });
    // The initial mount effect fires the first (stale-to-be) request; issue a second, superseding reload
    // before it resolves.
    act(() => {
      result.current.reload();
    });
    expect(call).toBe(2);
    // The newer request resolves first...
    await act(async () => {
      second.resolve(
        jsonResponse({
          events: [
            { id: "new", ts: "2026-01-01T00:00:00Z", type: "t", actor: { kind: "system" }, payload: {} },
          ],
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["new"]);
    // ...and the older, now-superseded request resolves after it — it must be dropped, not applied. This is
    // flushed inside `act` (not left to a bare `setTimeout`) so a would-be state write is actually committed
    // and visible on `result.current` before the assertion below runs, instead of silently racing it.
    await act(async () => {
      first.resolve(
        jsonResponse({
          events: [
            { id: "stale", ts: "2026-01-01T00:00:00Z", type: "t", actor: { kind: "system" }, payload: {} },
          ],
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["new"]);
  });
});
