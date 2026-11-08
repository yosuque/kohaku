import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { createKohakuHost } from "@kohaku-ui/host";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { describe, expect, it } from "vitest";
import { createMcpIntents } from "../src/intents.js";
import { createMcpDomainPort } from "../src/port.js";
import type { McpCallResult, McpToolClientLike, McpToolInfo } from "../src/types.js";
import { LIST_ORDERS, REFUND_ORDER } from "./fake-client.js";

const SECRET = "host-level-secret-of-decent-length";
const SOURCE = "orders";
const SIGNED_REF = "query://orders/list_orders?limit=1";

const ROWS = [1, 2, 3, 4].map((n) => ({ id: `o-${n}`, total: n * 10, placedAt: "2026-04-01" }));

interface Upstream extends McpToolClientLike {
  /** The `limit` argument of every list_orders call, as the upstream received it. */
  limits: unknown[];
  writes: number;
}

/**
 * An upstream whose `list_orders` does what a naive tool does with its `limit`: `rows.slice(0, limit)`. A negative
 * limit therefore returns "all but the last rows" instead of lowering anything, which is what `_limit=-1` used to
 * exploit. `refund_order` either answers, or (hangWrite) performs the write and then never answers.
 */
function upstream(options: { hangWrite?: boolean; hangRead?: boolean } = {}): Upstream {
  const tools: McpToolInfo[] = [LIST_ORDERS, REFUND_ORDER];
  const limits: unknown[] = [];
  const self = {
    limits,
    writes: 0,
    async listTools() {
      return { tools };
    },
    async callTool(params, callOptions): Promise<McpCallResult> {
      if (params.name === "list_orders") {
        limits.push(params.arguments?.["limit"]);
        if (options.hangRead === true) return hang(callOptions?.signal);
        const limit = params.arguments?.["limit"];
        const rows = ROWS.slice(0, typeof limit === "number" ? limit : undefined);
        return { content: [], structuredContent: { rows } };
      }
      self.writes += 1; // the effect happens ...
      if (options.hangWrite === true) return hang(callOptions?.signal); // ... but the answer is lost
      return { content: [], structuredContent: { refunded: true } };
    },
  } as Upstream;
  return self;
}

function hang(signal: AbortSignal | undefined): Promise<McpCallResult> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

async function setup(client: Upstream, callTimeoutMs = 30_000) {
  // "auto" tier: this file is about the write's outcome, not the approval gate (e2e.test.ts covers that).
  const port = await createMcpDomainPort({ client, callTimeoutMs, tierFor: () => "auto" });
  const authz = createHmacAuthzPort(SECRET);
  const errors: { endpoint: string; error: unknown }[] = [];
  const host = createKohakuHost({
    domain: port,
    querySource: SOURCE,
    llm: new FakeLlm({ objects: [] }),
    intents: createMcpIntents(port, { source: SOURCE }),
    dataVersion: port.dataVersion,
    authz,
    routes: { auth: async () => ({ id: "u", roles: [] }) },
    policy: { allowL2: false },
    onError: (info: { endpoint: string; error: unknown }) => {
      errors.push(info);
    },
  });
  return { host, port, authz, errors };
}

describe("domain-mcp behind the REST host: an unsigned _limit can only lower the signed limit", () => {
  it.each(["-1", "0", "0.5", "-1e9", "abc"])(
    "refuses _limit=%s on a ref signed with limit=1",
    async (bad) => {
      const client = upstream();
      const ctx = await setup(client);
      const cap = await ctx.authz.issueCapability({ id: "u", roles: [] }, [
        { kind: "read", ref: SIGNED_REF },
      ]);
      const res = await ctx.host.app.request(
        `/api/kohaku/binding/resolve?ref=${encodeURIComponent(`${SIGNED_REF}&_limit=${bad}`)}`,
        { headers: { authorization: `Bearer ${cap}` } },
      );
      // The same 404 every failed read gets; the upstream was never asked for a widened range.
      expect(res.status).toBe(404);
      expect(client.limits).toEqual([]);
    },
  );

  it("returns at most the signed one row when _limit is absent, and still honours a smaller positive _limit", async () => {
    const client = upstream();
    const ctx = await setup(client);
    const cap = await ctx.authz.issueCapability({ id: "u", roles: [] }, [{ kind: "read", ref: SIGNED_REF }]);
    const get = async (suffix: string) =>
      ctx.host.app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(SIGNED_REF + suffix)}`, {
        headers: { authorization: `Bearer ${cap}` },
      });
    const plain = await get("");
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { rows: unknown[] }).rows).toHaveLength(1);
    const wider = await get("&_limit=3");
    expect(wider.status).toBe(200);
    expect(((await wider.json()) as { rows: unknown[] }).rows).toHaveLength(1);
    expect(client.limits).toEqual([1, 1]);
  });
});

describe("domain-mcp behind the REST host: a timed-out call", () => {
  it("answers a write whose upstream call timed out with 503 INTERNAL and the fixed outcome-unknown message", async () => {
    const client = upstream({ hangWrite: true });
    const ctx = await setup(client, 20);
    const cap = await ctx.authz.issueCapability({ id: "u", roles: [] }, [
      { kind: "write", ref: "refund_order" },
    ]);
    const res = await ctx.host.app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
      body: JSON.stringify({ action: "refund_order", payload: { orderId: "o-1" } }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("the action's outcome is unknown; verify before retrying");
    // The write did happen upstream (that is the whole point), and it was sent exactly once.
    expect(client.writes).toBe(1);
    // The real error, with the tool name, went to onError only.
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0]?.endpoint).toBe("binding/action");
    expect(String(ctx.errors[0]?.error)).toContain('"refund_order"');
  });

  it("keeps a read timeout the ordinary failed read: 404 REF_NOT_FOUND", async () => {
    const client = upstream({ hangRead: true });
    const ctx = await setup(client, 20);
    const cap = await ctx.authz.issueCapability({ id: "u", roles: [] }, [{ kind: "read", ref: SIGNED_REF }]);
    const res = await ctx.host.app.request(
      `/api/kohaku/binding/resolve?ref=${encodeURIComponent(SIGNED_REF)}`,
      { headers: { authorization: `Bearer ${cap}` } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("REF_NOT_FOUND");
  });
});
