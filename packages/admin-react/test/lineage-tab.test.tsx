import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultAdminMessages, LineageTab } from "../src/index.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

describe("LineageTab", () => {
  it("renders the empty text and reloads on Refresh", async () => {
    let n = 0;
    const view = renderInAdmin(<LineageTab />, {
      handlers: {
        "GET /lineage": () => {
          n += 1;
          return jsonResponse({ events: [] });
        },
      },
    });
    await screen.findByText(defaultAdminMessages.lineage.empty);
    fireEvent.click(screen.getByText(defaultAdminMessages.refresh));
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(2);
    expect(view.calls.filter((c) => c.url.includes("/lineage")).length).toBe(2);
  });

  it("shows tier / cache / canonical / short hash / surface per event, newest first", async () => {
    const events = [
      {
        id: "1",
        ts: "2026-01-01T09:00:00Z",
        type: "view.composed",
        actor: { kind: "model" },
        payload: {
          tier: "L1",
          cache: "miss",
          canonical: "sales.trend",
          intentHash: "sha256:abcdef0123456789",
          surface: "web",
        },
      },
      {
        id: "2",
        ts: "2026-01-01T09:00:01Z",
        type: "view.rendered",
        actor: { kind: "user" },
        payload: {
          tier: "L1",
          cache: "hit",
          canonical: "sales.trend",
          intentHash: "sha256:abcdef0123456789",
          surface: "chat",
        },
      },
    ];
    renderInAdmin(<LineageTab />, { handlers: { "GET /lineage": () => jsonResponse({ events }) } });
    // Wait for the real data to land before inspecting rows: the initial render (before the GET /lineage
    // promise resolves) already contains a role="row" element (the empty-state <tr>), so `findAllByRole("row")`
    // would resolve on that very first synchronous check and never wait for the actual fetch to complete.
    await screen.findByText("view.rendered");
    const rows = screen.getAllByRole("row");
    expect(rows[0]!.textContent).toContain("view.rendered");
    expect(rows[0]!.textContent).toContain("#abcdef01");
    expect(rows[1]!.textContent).toContain("view.composed");
  });
});
