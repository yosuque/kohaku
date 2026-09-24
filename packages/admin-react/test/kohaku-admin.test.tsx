import { createKohakuClient } from "@kohaku-ui/client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KohakuAdmin, defaultAdminMessages as m, useAdminNotice } from "../src/index.js";
import { jsonResponse, stubClient } from "./helpers.js";

function Toolbar() {
  const notify = useAdminNotice();
  return (
    <button type="button" onClick={() => notify("bumped")}>
      bump
    </button>
  );
}

describe("KohakuAdmin", () => {
  it("renders the four tabs, switches on click, and shows toolbar notices in the banner", async () => {
    const { client } = stubClient({
      "GET /lineage": () => jsonResponse({ events: [] }),
      "GET /fixations/proposals": () => jsonResponse({ proposals: [] }),
      "GET /fixations": () => jsonResponse({ fixations: [] }),
    });
    render(<KohakuAdmin client={client} toolbar={<Toolbar />} />);
    await screen.findByText(m.lineage.empty);
    fireEvent.click(screen.getByText(m.tabFixations));
    await screen.findByText(m.fixations.fixatedTitle);
    fireEvent.click(screen.getByText("bump"));
    expect(screen.getByText("bumped")).toBeTruthy();
  });

  it("renders error notices with role=alert and applies theme variables on the root", async () => {
    const { client } = stubClient({
      "GET /analytics/summary": () =>
        jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
    });
    const { container } = render(
      <KohakuAdmin client={client} initialTab="analytics" theme={{ "color.primary": "#123456" }} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        m.deniedMessage("CAPABILITY_DENIED", m.analytics.opRead),
      ),
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--kohaku-color-primary")).toBe("#123456");
  });

  it("remounts the tabs when tenant changes and renders extra tabs", async () => {
    let lineageCalls = 0;
    const { client } = stubClient({
      "GET /lineage": () => {
        lineageCalls += 1;
        return jsonResponse({ events: [] });
      },
    });
    const extra = [{ key: "gallery", label: "Gallery", render: () => <div>gallery body</div> }];
    const view = render(<KohakuAdmin client={client} tenant="a" extraTabs={extra} />);
    await screen.findByText(m.lineage.empty);
    view.rerender(<KohakuAdmin client={client} tenant="b" extraTabs={extra} />);
    await waitFor(() => expect(lineageCalls).toBe(2));
    fireEvent.click(screen.getByText("Gallery"));
    expect(screen.getByText("gallery body")).toBeTruthy();
  });

  // Carried note: "tenant is a remount key. Role is NOT: changing role must not remount, only re-request."
  // Role has no KohakuAdminProps field at all (the sample keeps tenant/role as process-global pub/sub and
  // attaches the role header inside the host's own client, per docs/phase0-survey.md #6) — so this half of the
  // asymmetry is really "nothing other than `tenant` (and the active tab) may ever appear in the remount key,
  // and every request still goes through the live `client`, so the next request always carries whatever the
  // client's headers() hook returns right now." Both are exercised directly below.
  it("does not remount (and does not re-fetch) on a re-render that changes nothing but external, non-prop state such as role", async () => {
    let role = "admin";
    let listCalls = 0;
    const seenRoles: string[] = [];
    const candidate = {
      artifactId: "sales.customViz1@1",
      status: "candidate",
      uses: 3,
      sessions: 2,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const client = createKohakuClient({
      baseUrl: "/api/kohaku",
      headers: () => ({ "x-kohaku-role": role }),
      transport: async (url, init) => {
        seenRoles.push((init?.headers as Record<string, string> | undefined)?.["x-kohaku-role"] ?? "");
        if (url.endsWith("/promotions")) {
          listCalls += 1;
          return jsonResponse({ candidates: [candidate] });
        }
        if (url.endsWith("/analytics/summary")) {
          return jsonResponse({ promotionPolicy: { promotionMinUses: 2, fixationMinUses: 3 } });
        }
        throw new Error(`unhandled fetch: ${url}`);
      },
    });
    const view = render(<KohakuAdmin client={client} tenant="a" initialTab="promotions" />);
    await screen.findByText(candidate.artifactId);
    expect(listCalls).toBe(1);
    expect(seenRoles.at(-1)).toBe("admin");

    // A role switch elsewhere in the host app (module-level state, not a KohakuAdminProps field) followed by a
    // re-render with the SAME tenant: since only tenant (plus the active tab) is a remount key, this must not
    // unmount PromotionsTab, so its already-fetched candidate list is retained without any new list() call.
    role = "viewer";
    view.rerender(<KohakuAdmin client={client} tenant="a" initialTab="promotions" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listCalls).toBe(1);
    expect(screen.getByText(candidate.artifactId)).toBeTruthy();

    // The "re-request" half: the console never caches the role itself, so the very next call made through the
    // same client naturally carries the CURRENT role, with no special handling anywhere in this package.
    await client.promotions.list();
    expect(seenRoles.at(-1)).toBe("viewer");
  });
});
