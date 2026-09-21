import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FixationsTab, defaultAdminMessages as m } from "../src/index.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

const proposal = {
  intentHash: "sha256:aa",
  canonical: "sales.trend",
  params: { fy: 2026 },
  uses: 5,
  stability: 0.9,
};
const record = { intentHash: "sha256:bb", canonical: "sales.summary", fixatedAt: "2026-01-01T00:00:00.000Z" };

describe("FixationsTab", () => {
  it("renders both lists populated and fetches proposals + list + the analytics summary", async () => {
    const view = renderInAdmin(<FixationsTab />, {
      handlers: {
        "GET /fixations/proposals": () => jsonResponse({ proposals: [proposal] }),
        "GET /fixations": () => jsonResponse({ fixations: [record] }),
      },
    });
    await screen.findByText("sales.trend");
    // Both sections rendered from their own endpoint (not just one, and not from a single combined fetch).
    expect(screen.getByText("sales.summary")).toBeTruthy();
    // "5 uses / stability 90%" shares a <span> with the JSON.stringify(params) prefix, so it is not the whole
    // element's text — checked against the rendered text as a whole, as this package's other tab tests do for
    // composite text (see analytics-tab.test.tsx), rather than an exact getByText match.
    expect(view.container.textContent).toContain(m.fixations.usesStability(5, "90"));
    expect(screen.getByText(record.fixatedAt.slice(0, 19))).toBeTruthy();
    // useFixations has no test of its own: prove its full contract from here — proposals(), list() and
    // analytics.summary() are each actually fetched (three distinct GETs), not just the two the UI needs.
    expect(view.calls.some((c) => c.url.includes("/fixations/proposals"))).toBe(true);
    expect(view.calls.some((c) => c.url.endsWith("/fixations"))).toBe(true);
    expect(view.calls.some((c) => c.url.includes("/analytics/summary"))).toBe(true);
  });

  it("shows both empty states, with the candidates threshold read off analytics.summary()'s promotionPolicy", async () => {
    // A distinctive fixationMinUses (7) that appears nowhere else in this test's fixtures: if the empty-state
    // text shows this number, it can only have come from GET /analytics/summary's promotionPolicy — there is
    // no dedicated fixation-threshold endpoint for it to come from instead.
    renderInAdmin(<FixationsTab />, {
      handlers: {
        "GET /fixations/proposals": () => jsonResponse({ proposals: [] }),
        "GET /fixations": () => jsonResponse({ fixations: [] }),
        "GET /analytics/summary": () => jsonResponse({ promotionPolicy: { fixationMinUses: 7 } }),
      },
    });
    await screen.findByText(m.fixations.candidatesEmpty(7));
    expect(screen.getByText(m.fixations.none)).toBeTruthy();
  });

  it("approves a proposal with the canonical + params body and notifies", async () => {
    let approveBody: unknown = null;
    const view = renderInAdmin(<FixationsTab />, {
      handlers: {
        "GET /fixations/proposals": () => jsonResponse({ proposals: [proposal] }),
        "GET /fixations": () => jsonResponse({ fixations: [record] }),
        "POST /fixations/approve": (call) => {
          approveBody = JSON.parse(call.init!.body as string);
          return jsonResponse({ ok: true });
        },
      },
    });
    await screen.findByText("sales.trend");
    expect(view.container.textContent).toContain(m.fixations.usesStability(5, "90"));
    fireEvent.click(screen.getByText(m.fixations.fixateButton));
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toEqual({ text: m.fixations.fixatedNotice("sales.trend"), kind: "info" });
    expect(approveBody).toEqual({ intent: { canonical: "sales.trend", params: { fy: 2026 } } });
  });

  it("removes a fixation via the unfixate wire call and reloads without a success notice", async () => {
    let fixationsCallCount = 0;
    const view = renderInAdmin(<FixationsTab />, {
      handlers: {
        "GET /fixations/proposals": () => jsonResponse({ proposals: [] }),
        "GET /fixations": () => {
          fixationsCallCount += 1;
          return jsonResponse({ fixations: fixationsCallCount === 1 ? [record] : [] });
        },
        // unfixate() and the deprecated remove() both hit this exact wire path (see client.ts) — this proves
        // the remove button drives that endpoint, independent of which client method the tab calls by name.
        "POST /fixations/sha256%3Abb/remove": () => jsonResponse({ ok: true }),
      },
    });
    await screen.findByText("sales.summary");
    fireEvent.click(screen.getByText(m.fixations.removeButton));
    await waitFor(() => expect(screen.getByText(m.fixations.none)).toBeTruthy());
    // Bug-for-bug parity with the original tab: a successful remove reloads silently, no notice.
    expect(view.notices).toHaveLength(0);
    expect(fixationsCallCount).toBe(2);
  });

  it("shows the role explanation when remove is denied", async () => {
    const view = renderInAdmin(<FixationsTab />, {
      handlers: {
        "GET /fixations/proposals": () => jsonResponse({ proposals: [] }),
        "GET /fixations": () => jsonResponse({ fixations: [record] }),
        "POST /fixations/sha256%3Abb/remove": () =>
          jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
      },
    });
    await screen.findByText("sales.summary");
    expect(screen.getByText(m.fixations.candidatesEmpty(3))).toBeTruthy();
    fireEvent.click(screen.getByText(m.fixations.removeButton));
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toEqual({
      text: m.deniedMessage("CAPABILITY_DENIED", m.fixations.opRemove),
      kind: "error",
    });
  });
});
