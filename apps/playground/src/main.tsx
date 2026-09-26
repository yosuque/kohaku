import { App, ThemeModeProvider } from "@kohaku-ui-sample/web/app";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { installFetchShim } from "./host/fetch-shim.js";
import { createPlaygroundHostHandle } from "./host/reset.js";
import { PlaygroundBar } from "./PlaygroundBar.js";

/**
 * The static playground's real entry point (U5-2). Builds one host (`host/reset.ts`), installs the
 * same-origin fetch shim in front of it (`host/fetch-shim.ts`), then mounts sample-web's own `App`
 * unmodified under a `HashRouter` — a `BrowserRouter` 404s on a deep-linked path on GitHub Pages, which has
 * no server to fall back to `index.html` for an unknown path; a hash route never leaves the single
 * `index.html` request in the first place.
 */
async function main(): Promise<void> {
  const handle = await createPlaygroundHostHandle();
  installFetchShim(() => handle.getHost().app);

  const root = document.getElementById("root");
  if (root == null) throw new Error("#root element not found");

  createRoot(root).render(
    <StrictMode>
      <ThemeModeProvider>
        <HashRouter>
          <PlaygroundBar onReset={() => handle.reset()} />
          <App />
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
