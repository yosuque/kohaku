import type { ExplainReport, KohakuClient } from "@kohaku-ui/client";
import type { UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { KohakuDevTools, withDevToolsCapture } from "../src/devtools/index.js";
import { AXE_OPTIONS } from "./axe-config.js";

/** A KohakuClient stand-in exposing only `explain` (the sole method KohakuDevTools ever calls). */
function fakeClient(explain: KohakuClient["explain"]): KohakuClient {
  return { explain } as unknown as KohakuClient;
}

const REPORT: ExplainReport = {
  composes: [
    {
      eventId: "ev-1",
      ts: "2026-09-27T00:00:00.000Z",
      intentHash: "sha256:" + "a".repeat(64),
      canonical: "sales.trend",
      specHash: "sha256:" + "b".repeat(64),
      tier: "L1",
      cache: "miss",
      model: "test-model",
      correlationId: "req-1",
      generatorVersion: "gen-1",
      kit: { id: "default", version: "1" },
      cacheKey: "kohaku:0.2:sha256:aaa:v1:-",
      cacheKeyParts: { intentHash: "sha256:" + "a".repeat(64), dataVersion: "v1" },
      decision: {
        attempts: [{ kind: "l1", ok: true }],
        coalesced: true,
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    },
  ],
  scopes: [{ kind: "read", ref: "query://sales/summary" }],
  events: [
    {
      id: "ev-1",
      ts: "2026-09-27T00:00:00.000Z",
      actor: { kind: "model" },
      type: "view.composed",
      payload: { tier: "L1", cache: "miss" },
    },
  ],
};

const SPEC: UISpec = {
  kohaku: "0.1",
  intent: { canonical: "sales.trend", params: {}, hash: REPORT.composes[0]!.intentHash },
  dataVersion: "v1",
  components: [
    { id: "root", type: "layout.stack", props: {}, children: ["t"] },
    { id: "t", type: "presentSpreadsheet", props: {}, data: { $ref: "query://sales/summary" } },
  ],
  events: [],
  provenance: { tier: "L1", composedBy: "composer@0.1.0", cache: "miss" },
};

describe("KohakuDevTools", () => {
  it("renders nothing when enabled is false", () => {
    const { container } = render(<KohakuDevTools enabled={false} client={fakeClient(vi.fn())} />);
    expect(container.firstChild).toBeNull();
  });

  it("fetches and renders the explain report across every panel", async () => {
    const explain = vi.fn().mockResolvedValue(REPORT);
    render(<KohakuDevTools enabled client={fakeClient(explain)} spec={SPEC} />);

    fireEvent.change(screen.getByLabelText("Request ID"), { target: { value: "req-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));

    await screen.findByText("L1 / miss");
    expect(explain).toHaveBeenCalledWith("req-1", { spec: SPEC });

    // Provenance panel is shown by default.
    expect(screen.getByText(/sales\.trend/)).toBeTruthy();
    expect(screen.getByText("test-model")).toBeTruthy();
    expect(screen.getByText("default@1")).toBeTruthy();

    // Cache key panel.
    fireEvent.click(screen.getByRole("tab", { name: "Cache key" }));
    expect(screen.getByText("kohaku:0.2:sha256:aaa:v1:-")).toBeTruthy();

    // Decision panel.
    fireEvent.click(screen.getByRole("tab", { name: "Decision" }));
    expect(screen.getByText(/l1/)).toBeTruthy();
    expect(screen.getByText("Rode along on another compose under single-flight")).toBeTruthy();
    expect(screen.getByText("10 input / 20 output tokens")).toBeTruthy();

    // Scopes panel.
    fireEvent.click(screen.getByRole("tab", { name: "Scopes" }));
    expect(screen.getByText("query://sales/summary")).toBeTruthy();

    // Lineage panel.
    fireEvent.click(screen.getByRole("tab", { name: "Lineage" }));
    expect(screen.getByText("view.composed")).toBeTruthy();

    // Spec panel.
    fireEvent.click(screen.getByRole("tab", { name: "Spec" }));
    expect(screen.getByText("layout.stack")).toBeTruthy();
    expect(screen.getByText("presentSpreadsheet")).toBeTruthy();
  });

  it("shows an error banner when explain rejects", async () => {
    const explain = vi.fn().mockRejectedValue(new Error("network down"));
    render(<KohakuDevTools enabled client={fakeClient(explain)} />);

    fireEvent.change(screen.getByLabelText("Request ID"), { target: { value: "req-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("network down");
  });

  it("shows recent requests from withDevToolsCapture and explains one on click", async () => {
    const { config, capture } = withDevToolsCapture({ baseUrl: "/api/kohaku" });
    // Simulate two prior responses the client SDK would have reported (one with no requestId).
    config.onResponse?.({ path: "/compose", status: 200, requestId: "req-1" });
    config.onResponse?.({ path: "/promotions", status: 500 });

    const explain = vi.fn().mockResolvedValue(REPORT);
    render(<KohakuDevTools enabled client={fakeClient(explain)} capture={capture} />);

    const recentButton = await screen.findByRole("button", { name: /200 \/compose/ });
    const noIdButton = screen.getByRole("button", { name: /500 \/promotions/ }) as HTMLButtonElement;
    expect(noIdButton.disabled).toBe(true);

    fireEvent.click(recentButton);
    await waitFor(() => expect(explain).toHaveBeenCalledWith("req-1", undefined));
    expect((screen.getByLabelText("Request ID") as HTMLInputElement).value).toBe("req-1");
  });

  it("passes the axe structural ruleset once a report is rendered", async () => {
    const explain = vi.fn().mockResolvedValue(REPORT);
    const { container } = render(<KohakuDevTools enabled client={fakeClient(explain)} spec={SPEC} />);

    fireEvent.change(screen.getByLabelText("Request ID"), { target: { value: "req-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    await screen.findByText("L1 / miss");

    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
  });
});
