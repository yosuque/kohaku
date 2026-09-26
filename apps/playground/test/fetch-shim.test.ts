import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaygroundHost } from "../src/host/create-host.js";
import { installFetchShim } from "../src/host/fetch-shim.js";
import { createPlaygroundHostHandle } from "../src/host/reset.js";

const ORIGIN = "http://localhost:5173";

const QUARTERLY_GUI = {
  input: {
    kind: "gui",
    action: "view.select",
    params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 1, groupBy: "region" },
  },
};

const nativeFetch = globalThis.fetch;
let restoreShim: (() => void) | undefined;

afterEach(() => {
  restoreShim?.();
  restoreShim = undefined;
  globalThis.fetch = nativeFetch;
});

describe("installFetchShim: routing", () => {
  it("routes a same-origin /api/* request to the host's app.fetch", async () => {
    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: ORIGIN });

    const res = await fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; seed: { dataVersion: string } };
    expect(body.ok).toBe(true);
    // Proves the request actually reached the host (not some other handler) — the health payload carries
    // the playground's own seedTag, not the real demo seed's.
    expect(body.seed.dataVersion).toContain("playground-demo-seed-v1");
  });

  it("does not route a same-origin request outside <base>api/*", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("stub-asset", { status: 200 });
    }) as typeof fetch;

    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: ORIGIN });

    const res = await fetch(`${ORIGIN}/assets/index.js`);
    expect(await res.text()).toBe("stub-asset");
    expect(calls).toEqual([`${ORIGIN}/assets/index.js`]);
  });
});

describe("installFetchShim: base prefixing", () => {
  it("recognizes <base>api/* under a non-root base path (e.g. a GitHub Pages project site)", async () => {
    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: ORIGIN, base: "/kohaku/" });

    const res = await fetch(`${ORIGIN}/kohaku/api/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("plain root /api/* still matches under a non-root base too (sample-web's client hardcodes root-absolute paths)", async () => {
    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: ORIGIN, base: "/kohaku/" });

    // Not under /kohaku/ at all — the bare root path sample-web's kohaku/client.ts actually calls,
    // regardless of the deployed base. Must still route to the host (see apiPrefixesFor's doc comment).
    const res = await fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
  });

  it("a request that is neither root /api/* nor under <base>api/* is not routed", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("stub", { status: 200 });
    }) as typeof fetch;

    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: ORIGIN, base: "/kohaku/" });

    await fetch(`${ORIGIN}/kohaku/assets/index.js`);
    expect(calls).toEqual([`${ORIGIN}/kohaku/assets/index.js`]);
  });
});

describe("installFetchShim: cross-origin passthrough", () => {
  it("passes a different-origin request straight through to the real fetch, untouched", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("stub-network", { status: 200 });
    }) as typeof fetch;

    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: ORIGIN });

    const res = await fetch("https://example.com/some/api/path");
    expect(await res.text()).toBe("stub-network");
    expect(calls).toEqual(["https://example.com/some/api/path"]);
  });
});

describe("installFetchShim + reset: lineage starts empty again after a reset", () => {
  it("a compose recorded through the shim shows up in lineage, and disappears after reset()", async () => {
    const handle = await createPlaygroundHostHandle();
    restoreShim = installFetchShim(() => handle.getHost().app, { origin: ORIGIN });

    const composeRes = await fetch(`${ORIGIN}/api/kohaku/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(QUARTERLY_GUI),
    });
    expect(composeRes.status).toBe(200);
    expect(await handle.getHost().lineage.list()).not.toHaveLength(0);

    await handle.reset();

    expect(await handle.getHost().lineage.list()).toHaveLength(0);
  });
});
