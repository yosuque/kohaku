import { KohakuHostError } from "@kohaku-ui/client";
import { renderHook, waitFor } from "@testing-library/react";
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
