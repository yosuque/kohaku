/**
 * kohaku explain <requestId>: an end-to-end test against an in-process host-rest app (Hono's app.request as
 * the client transport), memory storage, and FakeLlm -- compose, then explain the request that produced it.
 */
import type { ComposeContext } from "@kohaku-ui/composer";
import { createKohakuRoutes, type KohakuHostDeps } from "@kohaku-ui/host-rest";
import { createLineage, createViewRecorder } from "@kohaku-ui/lineage";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SemanticPort } from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { formatExplainReport, runExplain } from "../src/commands.js";

const catalog = resolveCatalog(coreCatalog);

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return {};
  },
};

/**
 * normalize is never actually called: the test drives /compose with a structured Intent, which skips
 * SemanticPort.normalize. resolveQuery/dataVersion ARE called regardless (compose resolves the Intent's
 * available data reference up front, before generation decides whether to use it) -- the L1 draft below
 * does not end up referencing it (a plain markdown summary), but resolution still has to succeed.
 */
const stubSemantic: SemanticPort = {
  async normalize() {
    throw new Error("not expected to be called (structured-intent compose)");
  },
  async resolveQuery() {
    return { uri: "query://sales/summary" };
  },
  async dataVersion() {
    return "sales@v1";
  },
};

function allowAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true, principal: { id: "u", roles: ["user"] } };
    },
  };
}

/** A generation-schema-valid L1 draft with no $ref (a plain markdown summary; no query resolution needed). */
function l1Draft(): unknown {
  return {
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md"] },
      { id: "md", type: "presentMarkdown", props: { markdown: "Monthly sales trend: up 4%." } },
    ],
    events: [],
  };
}

function makeApp(): { app: Hono; storage: ReturnType<typeof createMemoryStoragePort> } {
  const storage = createMemoryStoragePort();
  const lineage = createLineage({ storage });
  const compose: ComposeContext = {
    catalog,
    semantic: stubSemantic,
    storage,
    llm: new FakeLlm({ objects: [l1Draft()] }),
  };
  const deps: KohakuHostDeps = {
    compose,
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    recorder: createViewRecorder(lineage),
  };
  const app = new Hono();
  app.route("/api/kohaku", createKohakuRoutes(deps));
  return { app, storage };
}

describe("kohaku explain (end-to-end via an in-process host-rest app)", () => {
  it("explains a compose it just performed: tier/cache, and the view.composed event", async () => {
    const { app } = makeApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));

    const composeRes = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(composeRes.status).toBe(200);
    const requestId = composeRes.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();

    const report = await runExplain(requestId!, { rest: "/api/kohaku", transport });
    expect(report.composes).toHaveLength(1);
    const c = report.composes[0]!;
    expect(c.canonical).toBe("sales.trend");
    expect(c.tier).toBe("L1");
    expect(c.cache).toBe("miss");
    expect(c.correlationId).toBe(requestId);
    expect(report.events.length).toBeGreaterThanOrEqual(1);
    expect(report.events.every((e) => e.type === "view.composed")).toBe(true);

    const text = formatExplainReport(report);
    expect(text).toContain("sales.trend");
    expect(text).toContain("L1 / miss");
    expect(text).toContain("Lineage events (1):");
  });

  it("--json (JSON.stringify(report)) round-trips the same data formatExplainReport renders", async () => {
    const { app } = makeApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    const composeRes = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    const requestId = composeRes.headers.get("X-Request-Id")!;

    const report = await runExplain(requestId, { rest: "/api/kohaku", transport });
    const roundTripped = JSON.parse(JSON.stringify(report));
    expect(roundTripped).toEqual(report);
  });

  it("reports no compose found for an unrelated requestId", async () => {
    const { app } = makeApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });

    const report = await runExplain("never-issued", { rest: "/api/kohaku", transport });
    expect(report.composes).toEqual([]);
    expect(report.events).toEqual([]);
    expect(formatExplainReport(report)).toContain("No view.composed event found for this requestId.");
  });

  it("escapes control characters in lineage-derived strings so a hostile record cannot drive the terminal", () => {
    const text = formatExplainReport({
      composes: [
        {
          eventId: "e1",
          ts: "2026-01-01T00:00:00.000Z",
          intentHash: "h",
          canonical: "evil\u001b[2J\rname\u009b",
          specHash: "s",
          tier: "L1",
          cache: "miss",
          decision: { attempts: [{ kind: "l1", ok: false, issues: ["bad\u0007bell", "keeps\nnewline"] }] },
        },
      ],
      events: [],
    });
    const controls = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return ch !== "\n" && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
    });
    expect(controls).toEqual([]);
    expect(text).toContain("evil\\x1b[2J\\x0dname\\x9b");
    expect(text).toContain("bad\\x07bell");
    // A newline inside a value is escaped too, so it cannot forge an extra report line.
    expect(text).toContain("keeps\\x0anewline");
    expect(text).not.toContain("keeps\nnewline");
  });

  it("rejects a malformed --header value", async () => {
    const { app } = makeApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    await expect(
      runExplain("whatever", { rest: "/api/kohaku", transport, headers: ["no-colon-here"] }),
    ).rejects.toThrow(/--header must be given as/);
  });
});
