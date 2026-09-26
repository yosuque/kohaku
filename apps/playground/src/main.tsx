import { App, ThemeModeProvider } from "@kohaku-ui-sample/web/app";
import { type ReactNode, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, useNavigate } from "react-router-dom";
import { installFetchShim } from "./host/fetch-shim.js";
import { RECORDED_SCENARIO_IDS } from "./host/fixtures.js";
import { createPlaygroundHostHandle, type PlaygroundHostHandle } from "./host/reset.js";
import { PlaygroundBar } from "./PlaygroundBar.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

/** Builds the URL search-param string DashboardPage's own `syncUrl`/`facet-views.ts` read from (`?intent=
 * <canonical>&<other param>=<value>...`) for a GUI-shaped scenario's `input.params` (which bundles `intent`
 * together with the rest — see scenarios.ts — unlike DashboardPage's own split `intentName`/`facetParams`). */
function guiScenarioPath(params: Record<string, unknown>): string {
  const { intent, ...rest } = params;
  const search = new URLSearchParams({ intent: String(intent) });
  for (const [key, value] of Object.entries(rest)) {
    if (value != null) search.set(key, String(value));
  }
  return `/?${search.toString()}`;
}

/**
 * `App`'s own `DashboardPage` composes only once, on mount (its `useEffect(() => {...}, [])` — see its own
 * doc comment: "Direct URL changes after mount ... are not picked up"), a deliberate limitation this
 * playground cannot fork around. Navigating while already on "/" would therefore silently do nothing, so
 * `Root` gives `<App>` a `key` that changes on every scenario run, forcing React to remount it (and hence
 * re-run that mount effect) with the new URL already in place.
 *
 * Also owns the fetch shim's install (a `useEffect` so its cleanup — restoring the pre-shim `fetch` — runs
 * correctly under StrictMode's dev-only double-invoke) and the generation-fallback notice it can report
 * (see `fetch-shim.ts`'s `onGenerationFallback`), since showing that notice needs `setState` from inside
 * this component.
 */
function Root({ handle }: { handle: PlaygroundHostHandle }): ReactNode {
  const navigate = useNavigate();
  const [remountKey, setRemountKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    return installFetchShim(() => handle.getHost().app, {
      onGenerationFallback: ({ from, reason }) => {
        const message = `This scenario's response hasn't been recorded yet (${from}: ${reason}). The result shown is composer's deterministic fallback — try an L0 example from the toolbar instead.`;
        console.info(`[playground] generation fallback: ${message}`);
        setNotice(message);
      },
    });
  }, [handle]);

  const runScenario = useCallback(
    (scenario: Scenario) => {
      if (scenario.input.kind === "gui") {
        navigate(guiScenarioPath(scenario.input.params));
      } else {
        // No Dashboard URL shape covers an NL question, and ChatPage has no prop to prefill its input
        // without forking it — this is a best-effort "go ask it yourself" nudge, not a one-click replay.
        navigate("/chat");
      }
      setRemountKey((key) => key + 1);
    },
    [navigate],
  );

  return (
    <>
      <PlaygroundBar
        onReset={() => handle.reset()}
        scenarios={SCENARIOS}
        recordedScenarioIds={RECORDED_SCENARIO_IDS}
        onRunScenario={runScenario}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
      />
      <App key={remountKey} />
    </>
  );
}

/**
 * The static playground's real entry point (U5-2/U5-3). Builds one host (`host/reset.ts`) and mounts
 * sample-web's own `App` unmodified (via `Root`, above) under a `HashRouter` — a `BrowserRouter` 404s on a
 * deep-linked path on GitHub Pages, which has no server to fall back to `index.html` for an unknown path; a
 * hash route never leaves the single `index.html` request in the first place.
 */
async function main(): Promise<void> {
  const handle = await createPlaygroundHostHandle();

  const root = document.getElementById("root");
  if (root == null) throw new Error("#root element not found");

  createRoot(root).render(
    <StrictMode>
      <ThemeModeProvider>
        <HashRouter>
          <Root handle={handle} />
        </HashRouter>
      </ThemeModeProvider>
    </StrictMode>,
  );
}

main().catch((error: unknown) => {
  console.error("[playground] failed to start:", error);
  const root = document.getElementById("root");
  if (root != null) root.textContent = `Failed to start: ${String(error)}`;
});
