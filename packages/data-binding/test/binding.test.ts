import type { TabularData } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BindingError,
  createBindingClient,
  formatQueryRef,
  parseQueryRef,
  splitReservedParams,
} from "../src/index.js";

describe("parseQueryRef / formatQueryRef", () => {
  it("parses and reformats into canonical form (key-sorted)", () => {
    const ref = parseQueryRef("query://sales/summary?q=3&fy=2026&groupBy=region");
    expect(ref.source).toBe("sales");
    expect(ref.path).toBe("summary");
    expect(ref.params).toEqual({ q: "3", fy: "2026", groupBy: "region" });
    expect(ref.raw).toBe("query://sales/summary?fy=2026&groupBy=region&q=3");
  });

  it("handles no parameters and encoding", () => {
    expect(parseQueryRef("query://sales/records").raw).toBe("query://sales/records");
    const ref = parseQueryRef("query://sales/records?region=north%20america");
    expect(ref.params["region"]).toBe("north america");
    expect(formatQueryRef(ref)).toContain("north%20america");
  });

  it("an invalid URI is a QueryRefError", () => {
    expect(() => parseQueryRef("http://sales/summary")).toThrow(/invalid query ref/);
    expect(() => parseQueryRef("query://Sales/summary")).toThrow(/invalid query ref/);
  });
});

const DATA: TabularData = {
  columns: [
    { key: "region", type: "string" },
    { key: "revenue", type: "number" },
  ],
  rows: [
    { region: "japan", revenue: 100 },
    { region: "apac", revenue: 50 },
  ],
  dataVersion: "sales@seed-1",
};

describe("BindingClient", () => {
  it("successful resolution (attaches capability, fetches with canonical ref)", async () => {
    const seen: { raw?: string; capability?: string } = {};
    const client = createBindingClient({
      capability: "cap-token",
      fetcher: async (ref, init) => {
        seen.raw = ref.raw;
        seen.capability = init.capability;
        return { status: 200, body: DATA };
      },
    });
    const data = await client.resolve(
      { $ref: "query://sales/summary?q=3&fy=2026" },
      { expectedDataVersion: "sales@seed-1" },
    );
    expect(data.rows).toHaveLength(2);
    expect(seen.raw).toBe("query://sales/summary?fy=2026&q=3");
    expect(seen.capability).toBe("cap-token");
  });

  it("401/403 → UNAUTHORIZED", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 403, body: null }),
    });
    await expect(client.resolve("query://sales/summary")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    } satisfies Partial<BindingError>);
  });

  it("dataVersion mismatch → STALE_VERSION", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: { ...DATA, dataVersion: "sales@seed-2" } }),
    });
    await expect(
      client.resolve("query://sales/summary", { expectedDataVersion: "sales@seed-1" }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("invokeAction propagates opts.signal to actionFetcher's init.signal", async () => {
    let seen: unknown;
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: DATA }),
      actionFetcher: async (_action, _payload, init) => {
        seen = init.signal;
        return { status: 200, body: { result: { ok: true } } };
      },
    });
    // data-binding is environment-neutral (AbortSignalLike = unknown), so instead of a real AbortController
    // we use a sentinel object to check only identity (pass-through).
    const signal = { aborted: false };
    await client.invokeAction("annotate", { note: "x" }, { signal });
    expect(seen).toBe(signal);
  });

  it("an invalid ref → BAD_REF (does not go to fetch)", async () => {
    let called = false;
    const client = createBindingClient({
      fetcher: async () => {
        called = true;
        return { status: 200, body: DATA };
      },
    });
    await expect(client.resolve("not-a-ref")).rejects.toMatchObject({ code: "BAD_REF" });
    expect(called).toBe(false);
  });
});

describe("resolve: HTTP status / malformed-payload error mapping", () => {
  const cases: [number | "malformed-rows" | "malformed-columns" | "malformed-dataversion", string][] = [
    [404, "REF_NOT_FOUND"],
    [500, "RESOLVE_FAILED"],
    ["malformed-rows", "RESOLVE_FAILED"],
    ["malformed-columns", "RESOLVE_FAILED"],
    ["malformed-dataversion", "RESOLVE_FAILED"],
  ];

  it.each(cases)("case %s → %s", async (status, expectedCode) => {
    let body: unknown;
    let httpStatus = 200;
    if (status === "malformed-rows") {
      body = { ...DATA, rows: "x" };
    } else if (status === "malformed-columns") {
      body = { ...DATA, columns: [{ key: 1 }] };
    } else if (status === "malformed-dataversion") {
      body = { ...DATA, dataVersion: 1 };
    } else {
      httpStatus = status;
      body = null;
    }
    const client = createBindingClient({
      fetcher: async () => ({ status: httpStatus, body }),
    });
    await expect(client.resolve("query://sales/summary")).rejects.toMatchObject({ code: expectedCode });
  });
});

describe("invokeAction: error mapping", () => {
  it("no actionFetcher configured → RESOLVE_FAILED", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: DATA }),
    });
    await expect(client.invokeAction("annotate", { note: "x" })).rejects.toMatchObject({
      code: "RESOLVE_FAILED",
    });
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "UNAUTHORIZED"],
    [500, "RESOLVE_FAILED"],
  ])("status %d → %s", async (status, expectedCode) => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: DATA }),
      actionFetcher: async () => ({ status, body: null }),
    });
    await expect(client.invokeAction("annotate", { note: "x" })).rejects.toMatchObject({
      code: expectedCode,
    });
  });
});

describe("invokeAction: parseActionResult shaping", () => {
  it("a non-object body is wrapped as { result: body }", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: DATA }),
      actionFetcher: async () => ({ status: 200, body: "just-a-string" }),
    });
    const result = await client.invokeAction("annotate", {});
    expect(result).toEqual({ result: "just-a-string" });
  });

  it("non-string entries in invalidates drop the whole invalidates field", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: DATA }),
      actionFetcher: async () => ({
        status: 200,
        body: { result: { ok: true }, invalidates: ["query://sales/summary", 42] },
      }),
    });
    const result = await client.invokeAction("annotate", {});
    expect(result.invalidates).toBeUndefined();
  });

  it("non-string values in refVersions are filtered out, keeping only string-valued entries", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: DATA }),
      actionFetcher: async () => ({
        status: 200,
        body: {
          result: { ok: true },
          refVersions: { "query://sales/summary": "v2", "query://sales/other": 7 },
        },
      }),
    });
    const result = await client.invokeAction("annotate", {});
    expect(result.refVersions).toEqual({ "query://sales/summary": "v2" });
  });
});

describe("in-flight sharing of resolve (dedup)", () => {
  /** A deferred fetch response that can be settled manually. */
  function deferred(): {
    promise: Promise<{ status: number; body: unknown }>;
    resolve: (v: { status: number; body: unknown }) => void;
    reject: (e: unknown) => void;
  } {
    let resolve!: (v: { status: number; body: unknown }) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<{ status: number; body: unknown }>((rs, rj) => {
      resolve = rs;
      reject = rj;
    });
    return { promise, resolve, reject };
  }

  it("concurrent resolves of the same ref call the fetcher only once and return the same result to all waiters", async () => {
    let calls = 0;
    const gate = deferred();
    const client = createBindingClient({
      fetcher: async () => {
        calls++;
        return gate.promise;
      },
    });
    // Even with notational variance (key order), if the normalized ref is identical the request is shared.
    const p1 = client.resolve("query://sales/summary?q=3&fy=2026");
    const p2 = client.resolve({ $ref: "query://sales/summary?fy=2026&q=3" });
    gate.resolve({ status: 200, body: DATA });
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(d1.rows).toHaveLength(2);
    expect(d2).toEqual(d1);
  });

  it("a failure during sharing propagates to all concurrent waiters, and the dedup is released after settling (re-fetches)", async () => {
    let calls = 0;
    const gate = deferred();
    const client = createBindingClient({
      fetcher: async () => {
        calls++;
        return calls === 1 ? gate.promise : { status: 200, body: DATA };
      },
    });
    const p1 = client.resolve("query://sales/summary");
    const p2 = client.resolve("query://sales/summary");
    gate.reject(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    expect(calls).toBe(1);
    // Since it was removed from the Map in finally, the next resolve does not carry over the failure and re-fetches.
    const data = await client.resolve("query://sales/summary");
    expect(data.rows).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("concurrent resolves with a different expectedDataVersion are not shared (part of the key)", async () => {
    let calls = 0;
    const client = createBindingClient({
      fetcher: async () => {
        calls++;
        return { status: 200, body: DATA };
      },
    });
    await Promise.all([
      client.resolve("query://sales/summary", { expectedDataVersion: "sales@seed-1" }),
      client.resolve("query://sales/summary"),
    ]);
    expect(calls).toBe(2);
  });

  it("concurrent resolves of the same ref under different capability getters are not deduplicated (each fetches with its own Authorization)", async () => {
    // Simulates a tenant switch mid-flight: the same client instance resolves the same ref twice while
    // config.capability (a getter) has changed between the two calls. Without an auth-context fingerprint
    // in the dedup key, the second caller would collide with the first's in-flight promise and silently
    // receive tenant A's data under tenant B's request.
    let cap = "cap-a";
    const seen: string[] = [];
    const client = createBindingClient({
      capability: () => cap,
      fetcher: async (_ref, init) => {
        seen.push(init.capability ?? "");
        return { status: 200, body: { ...DATA, dataVersion: `sales@${init.capability}` } };
      },
    });
    const p1 = client.resolve("query://sales/summary");
    cap = "cap-b";
    const p2 = client.resolve("query://sales/summary");
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(seen).toEqual(["cap-a", "cap-b"]);
    expect(d1.dataVersion).toBe("sales@cap-a");
    expect(d2.dataVersion).toBe("sales@cap-b");
  });

  it("concurrent resolves under the same auth context (capability + headers) are still deduplicated (one fetch)", async () => {
    let calls = 0;
    const gate = deferred();
    const client = createBindingClient({
      capability: () => "cap-a",
      headers: () => ({ "x-kohaku-tenant": "tenant-a" }),
      fetcher: async () => {
        calls++;
        return gate.promise;
      },
    });
    const p1 = client.resolve("query://sales/summary");
    const p2 = client.resolve("query://sales/summary");
    gate.resolve({ status: 200, body: DATA });
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it("a resolve with a signal is excluded from dedup and fetches independently", async () => {
    // Sharing would propagate the leading caller's abort to unrelated waiters, so requests with a signal run independently (see the implementation comment).
    let calls = 0;
    const gate = deferred();
    const client = createBindingClient({
      fetcher: async () => {
        calls++;
        return gate.promise;
      },
    });
    // Because it is environment-neutral (AbortSignalLike = unknown) we substitute a sentinel (non-null → excluded from dedup).
    const p1 = client.resolve("query://sales/summary");
    const p2 = client.resolve("query://sales/summary", { signal: { aborted: false } });
    gate.resolve({ status: 200, body: DATA });
    await Promise.all([p1, p2]);
    expect(calls).toBe(2);
  });
});

describe("matching boundary when dataVersion is omitted (fail-closed confirmation)", () => {
  const { dataVersion: _omit, ...WITHOUT_VERSION } = DATA;

  it("STALE_VERSION when the response omits dataVersion and expectedDataVersion is present (cannot match = fail-closed)", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: WITHOUT_VERSION }),
    });
    await expect(
      client.resolve("query://sales/summary", { expectedDataVersion: "sales@seed-1" }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("can resolve when dataVersion is omitted if expectedDataVersion is absent (omission is SHOULD, so allowed)", async () => {
    const client = createBindingClient({
      fetcher: async () => ({ status: 200, body: WITHOUT_VERSION }),
    });
    const data = await client.resolve("query://sales/summary");
    expect(data.rows).toHaveLength(2);
  });
});

describe("splitReservedParams / server-side paging", () => {
  it("splits reserved parameters (leading _) into base and reserved; base.raw matches the original $ref", () => {
    const { base, reserved } = splitReservedParams("query://sales/records?_limit=50&_cursor=100:v1&fy=2026");
    expect(base.raw).toBe("query://sales/records?fy=2026");
    expect(reserved).toEqual({ _limit: "50", _cursor: "100:v1" });
  });

  it("trap: a canonical URI with reserved parameters is not a prefix of the base ref (which is why validation runs against base)", () => {
    const full = parseQueryRef("query://sales/records?_limit=50&fy=2026").raw;
    const { base } = splitReservedParams("query://sales/records?_limit=50&fy=2026");
    // `_` (0x5F) sorts before lowercase letters, so _limit comes before fy.
    expect(full).toBe("query://sales/records?_limit=50&fy=2026");
    // Hence full does not have base.raw as a prefix (the reason capability prefix-match validation must run against base).
    expect(full.startsWith(base.raw)).toBe(false);
    expect(base.raw).toBe("query://sales/records?fy=2026");
  });

  it("resolve maps page/sort into reserved parameters, merges them into the ref, and re-canonicalizes", async () => {
    let seenRaw: string | undefined;
    const client = createBindingClient({
      fetcher: async (ref) => {
        seenRaw = ref.raw;
        return { status: 200, body: DATA };
      },
    });
    await client.resolve("query://sales/records?fy=2026", {
      page: { cursor: "100:v1", limit: 50 },
      sort: { key: "revenue", dir: "desc" },
    });
    // The reserved parameters merge in and become a key-sorted canonical form (_ sorts before lowercase letters).
    expect(seenRaw).toBe("query://sales/records?_cursor=100%3Av1&_dir=desc&_limit=50&_sort=revenue&fy=2026");
  });

  it("resolve does not change the ref when page/sort are unspecified (backward compatible)", async () => {
    let seenRaw: string | undefined;
    const client = createBindingClient({
      fetcher: async (ref) => {
        seenRaw = ref.raw;
        return { status: 200, body: DATA };
      },
    });
    await client.resolve("query://sales/records?fy=2026");
    expect(seenRaw).toBe("query://sales/records?fy=2026");
  });

  it("BAD_REF when the $ref itself contains reserved parameters (leading _) (does not go to fetch)", async () => {
    let called = false;
    const client = createBindingClient({
      fetcher: async () => {
        called = true;
        return { status: 200, body: DATA };
      },
    });
    await expect(client.resolve("query://sales/records?_limit=50&fy=2026")).rejects.toMatchObject({
      code: "BAD_REF",
    });
    expect(called).toBe(false);
  });
});

describe("headers hook (baseUrl default fetcher)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds extra headers to each resolve / action request (evaluated every time since it is a function)", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        status: 200,
        async json() {
          return url.includes("/binding/action") ? { result: { ok: true } } : DATA;
        },
        async text() {
          return "";
        },
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    let tenant = "tenant-a";
    const client = createBindingClient({
      baseUrl: "/api/kohaku",
      capability: "cap",
      headers: () => ({ "x-kohaku-tenant": tenant }),
    });

    await client.resolve("query://sales/summary?fy=2026");
    expect(calls[0]!.url).toContain("/binding/resolve");
    expect(calls[0]!.headers["x-kohaku-tenant"]).toBe("tenant-a");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer cap");

    // Because it is a function, a switch is reflected in the next request (a tenant switch takes effect immediately).
    tenant = "tenant-b";
    await client.invokeAction("annotate", { note: "hi" });
    expect(calls[1]!.url).toContain("/binding/action");
    expect(calls[1]!.headers["x-kohaku-tenant"]).toBe("tenant-b");
    expect(calls[1]!.headers["content-type"]).toBe("application/json");
  });

  it("pins the headers value read at resolve() time — the default fetcher must not re-evaluate the headers hook itself", async () => {
    // A getter keyed on its own call count: if resolve() pins the value once (structurally correct),
    // the fetcher only ever sees the first call's result. If the default fetcher instead re-evaluated
    // the hook itself (the bug this guards against), it would observe a *second* call and thus a
    // different value than the one resolve() used for its dedup fingerprint.
    let headerCalls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => ({
      status: 200,
      async json() {
        return { ...DATA, seenTenant: init?.headers?.["x-kohaku-tenant"] };
      },
      async text() {
        return "";
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createBindingClient({
      baseUrl: "/api/kohaku",
      headers: () => {
        headerCalls++;
        return { "x-kohaku-tenant": headerCalls === 1 ? "tenant-a" : "tenant-b" };
      },
    });

    const data = await client.resolve("query://sales/summary?fy=2026");
    expect(headerCalls).toBe(1);
    expect((data as unknown as { seenTenant?: string }).seenTenant).toBe("tenant-a");
  });
});
