import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { createApp } from "@kohaku-ui-sample/api";

/**
 * Node-dependency spike (U5-1 task 1 only): build sample-api's app with in-memory / fake Ports and call
 * `app.fetch` once, entirely in the browser. The point of this file is not what it does at runtime — it's
 * that `vite build` (see ../vite/forbid-node-builtins.ts's audit mode) walks the *exact* module graph a
 * real playground host would, so every Node-only import reachable from sample-api's app surfaces here.
 * UI (sample-web's `./app` export, HashRouter-mounted) and the browser-safe host wiring are follow-up
 * briefs once the audit below has picked which fixes to make.
 */
async function run(): Promise<string> {
  const { app } = await createApp({
    llm: new FakeLlm({}),
    storage: createMemoryStoragePort(),
    // A fixed demo-only secret for this spike. The real playground gets its own WebCrypto HMAC
    // implementation per U5's plan; authz-hmac itself (node:crypto-based) is not meant to run here.
    authz: createHmacAuthzPort("playground-spike-only-secret"),
  });
  const response = await app.fetch(new Request("http://playground.local/api/health"));
  return `GET /api/health -> ${response.status} ${await response.text()}`;
}

const output = document.getElementById("output");

run()
  .then((message) => {
    console.log("[playground]", message);
    if (output != null) output.textContent = message;
  })
  .catch((error: unknown) => {
    console.error("[playground] spike run failed:", error);
    if (output != null) output.textContent = `failed: ${String(error)}`;
  });
