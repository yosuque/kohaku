import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaygroundHost } from "../src/host/create-host.js";
import { type FetchShimTarget, installFetchShim } from "../src/host/fetch-shim.js";
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
  it("routes a bare relative /api/* string — exactly how sample-web's own client calls fetch()", async () => {
    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: ORIGIN });

    // No origin/host prefix at all: new Request("/api/health") would throw without resolving this against
    // `origin` first (Node's fetch, unlike a real browser's, has no "current page" to resolve a relative
    // URL against) — this is the exact call shape apps/sample-web/src/kohaku/client.ts uses.
    const res = await fetch("/api/health");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

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

describe("installFetchShim: AbortSignal forwarding", () => {
  it("forwards the caller's AbortSignal, so aborting mid-request is observable by the routed handler", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedAborted: boolean | undefined;
    const target: FetchShimTarget = {
      fetch: (request) =>
        new Promise((resolve) => {
          started();
          request.signal.addEventListener("abort", () => {
            observedAborted = request.signal.aborted;
            resolve(new Response(null, { status: 499 }));
          });
        }),
    };
    restoreShim = installFetchShim(() => target, { origin: ORIGIN });

    const controller = new AbortController();
    const pending = fetch(`${ORIGIN}/api/kohaku/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(QUARTERLY_GUI),
      signal: controller.signal,
    });
    // Wait for the request to actually reach the routed handler before aborting, so this exercises
    // cancellation of an in-flight request rather than one that never started.
    await startedPromise;
    controller.abort();
    await pending;

    expect(observedAborted).toBe(true);
  });

  it("leaves an unaborted request's signal unaffected", async () => {
    let observedAborted: boolean | undefined;
    const target: FetchShimTarget = {
      fetch: (request) => {
        observedAborted = request.signal.aborted;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };
    restoreShim = installFetchShim(() => target, { origin: ORIGIN });

    const res = await fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    expect(observedAborted).toBe(false);
  });
});

describe("installFetchShim: onGenerationFallback", () => {
  it("fires when an L1 compose has no recorded fixture and degrades to composer's deterministic fallback", async () => {
    const host = await createPlaygroundHost({}); // no fixtures -> the LLM call always misses
    const fallbacks: { from: string; reason: string }[] = [];
    restoreShim = installFetchShim(() => host.app, {
      origin: ORIGIN,
      onGenerationFallback: (info) => fallbacks.push(info),
    });

    const res = await fetch(`${ORIGIN}/api/kohaku/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: {
          kind: "gui",
          action: "view.select",
          params: { intent: "sales.trend", metric: "revenue", granularity: "month" },
        },
      }),
    });
    expect(res.status).toBe(200); // the screen does not break — composer delivers the fallback Spec
    // onGenerationFallback is notified asynchronously (it peeks at a clone of the response after this
    // function already returned it), so give the microtask queue a turn before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fallbacks).toHaveLength(1);
    // composer cascades L1 -> L2 -> deterministic fallback on failure (both attempts throw here, since
    // neither has a recorded fixture), so `from` reports L2 — the last tier actually attempted — even
    // though this scenario started as an L1 request.
    expect(fallbacks[0]!.from).toBe("L2");
  });

  it("does not fire for a successful L0 compose (no fallback occurred)", async () => {
    const host = await createPlaygroundHost();
    const fallbacks: unknown[] = [];
    restoreShim = installFetchShim(() => host.app, {
      origin: ORIGIN,
      onGenerationFallback: (info) => fallbacks.push(info),
    });

    await fetch(`${ORIGIN}/api/kohaku/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(QUARTERLY_GUI),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fallbacks).toHaveLength(0);
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
