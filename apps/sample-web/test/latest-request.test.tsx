import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useT } from "../src/i18n/ui.js";
import { DashboardPage } from "../src/pages/DashboardPage.js";
import { ThemeModeProvider } from "../src/theme/mode.js";

/**
 * Characterization test for the request-generation guard (seq ref pattern) used identically in
 * DashboardPage.runCompose/handleEvent and ChatPage's StreamingAssistant.handleEvent (a future refactor may
 * extract this guard into a shared useLatestRequest()). This test exercises DashboardPage's real
 * mount-time compose (request A) plus a facet-triggered compose (request B), and pins the exact behavior:
 * fire A then B, resolve B then A out of order — the displayed result must stay B, and A's late response
 * must not revert the view or surface an error.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function composeSpecResponse(markdown: string, canonical: string): unknown {
  return {
    spec: {
      kohaku: "0.1",
      intent: { canonical, params: {}, hash: "sha256:" + "0".repeat(64) },
      dataVersion: "v1",
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
        { id: "md1", type: "presentMarkdown", props: { markdown } },
      ],
      events: [],
      provenance: { tier: "L0", composedBy: "test", cache: "miss" },
    },
    capability: "cap-token",
  };
}

interface Deferred {
  url: string;
  respond: (body: unknown) => void;
}

function stubComposeFetch(): Deferred[] {
  const calls: Deferred[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      let resolve!: (res: Response) => void;
      const promise = new Promise<Response>((res) => {
        resolve = res;
      });
      calls.push({ url, respond: (body) => resolve(jsonResponse(body)) });
      return promise;
    }),
  );
  return calls;
}

describe("DashboardPage request-generation guard (characterization, pre-refactor)", () => {
  beforeEach(() => {
    // jsdom does not implement matchMedia; ThemeModeProvider's initial-mode detection needs a stub.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }),
    );
    // Node's built-in `localStorage` global (unconfigured, no --localstorage-file) shadows jsdom's Storage
    // implementation in this Vitest/Node combination; ThemeModeProvider.initialMode() calls it unguarded
    // (unlike i18n/lang.ts and kohaku/role.ts, which already wrap the same call in try/catch), so it needs
    // a minimal in-memory stub here (test-only; does not touch DashboardPage or ThemeModeProvider source).
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the later request's result when the earlier one resolves after it (out-of-order resolution)", async () => {
    const calls = stubComposeFetch();

    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    // Request A fires on mount (DashboardPage's initial useEffect).
    await waitFor(() => expect(calls).toHaveLength(1));

    // Request B fires from a facet (view) change before A resolves.
    fireEvent.click(screen.getByLabelText("Trend"));
    await waitFor(() => expect(calls).toHaveLength(2));

    // Resolve B first.
    calls[1]!.respond(composeSpecResponse("View B content", "sales.trend"));
    await screen.findByText("View B content");

    // Now resolve A (the stale, earlier request) — it must not roll back the display.
    calls[0]!.respond(composeSpecResponse("View A content", "sales.quarterly_summary"));
    // Give the resolved microtask a chance to flow through React state updates, if it were (incorrectly) applied.
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("View B content")).toBeTruthy();
    expect(screen.queryByText("View A content")).toBeNull();

    // No stale/duplicate loading indicator and no error banner left over from the guard.
    const composingLabel = renderComposingLabel();
    expect(screen.queryByText(composingLabel)).toBeNull();
  });
});

/** Reads the exact "composing" label from the same i18n dictionary DashboardPage renders with. */
function renderComposingLabel(): string {
  let label = "";
  function Probe(): null {
    label = useT().dashboard.composing;
    return null;
  }
  render(<Probe />);
  return label;
}
