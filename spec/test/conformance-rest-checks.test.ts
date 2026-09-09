import { describe, expect, it } from "vitest";
import { buildReport, formatReport, runRestSuite } from "../conformance/index.js";
import type { ConformanceResult, RestTarget } from "../conformance/types.js";

// The black-box check applies with just a baseUrl (fetch), so the fake host is built from a plain
// fetch function (path/init → Response) rather than Hono etc. (keeps the checked target independent).

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function readBody(init?: RequestInit): unknown {
  if (init?.body == null) return null;
  try {
    return JSON.parse(String(init.body));
  } catch {
    return null;
  }
}

const VALID_ACTION_KINDS = new Set([
  "nominate",
  "judge.start",
  "judge.result",
  "review.start",
  "review.approve",
  "review.requestChanges",
  "review.reject",
  "schema.propose",
  "publish",
  "withdraw",
  "unpublish",
]);

interface LineageEvent {
  type: string;
  ts: string;
  actor?: { kind?: string };
  payload?: Record<string, unknown>;
}

interface FakeConfig {
  lineage: LineageEvent[];
  /** When true, GET /promotions and /fixations return 501 NOT_IMPLEMENTED. */
  governanceNotImpl?: boolean;
  /** When set, GET /lineage responds with this status instead of 200 (simulates it being unreachable/erroring). */
  lineageStatus?: number;
}

function fakeTarget(cfg: FakeConfig): RestTarget {
  const NOT_IMPL = { error: { code: "NOT_IMPLEMENTED", message: "not configured" } };
  const fetchImpl = (path: string, init?: RequestInit): Promise<Response> => {
    const [pathname, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const method = init?.method ?? "GET";

    if (pathname === "/compose" && method === "POST") {
      const body = readBody(init) as { input?: unknown; intent?: unknown } | null;
      if (body == null || (body.input == null && body.intent == null)) {
        return Promise.resolve(
          jsonRes({ error: { code: "BAD_REQUEST", message: "either input or intent is required" } }, 400),
        );
      }
      return Promise.resolve(jsonRes({ spec: {}, capability: "cap" }));
    }
    if (pathname === "/promotions" && method === "GET") {
      return Promise.resolve(cfg.governanceNotImpl ? jsonRes(NOT_IMPL, 501) : jsonRes({ candidates: [] }));
    }
    if (pathname === "/fixations" && method === "GET") {
      return Promise.resolve(cfg.governanceNotImpl ? jsonRes(NOT_IMPL, 501) : jsonRes({ fixations: [] }));
    }
    if (pathname === "/lineage" && method === "GET") {
      if (cfg.lineageStatus != null && cfg.lineageStatus !== 200) {
        return Promise.resolve(
          jsonRes({ error: { code: "INTERNAL", message: "lineage store unavailable" } }, cfg.lineageStatus),
        );
      }
      const limitRaw = Number(params.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
      const events = limit != null ? cfg.lineage.slice(0, limit) : cfg.lineage;
      return Promise.resolve(jsonRes({ events }));
    }
    if (/^\/promotions\/[^/]+\/actions$/.test(pathname) && method === "POST") {
      const raw = readBody(init) as { action?: { kind?: unknown } } | null;
      const kind = raw?.action?.kind;
      if (typeof kind !== "string" || !VALID_ACTION_KINDS.has(kind)) {
        return Promise.resolve(
          jsonRes({ error: { code: "BAD_REQUEST", message: "action.kind is invalid" } }, 400),
        );
      }
      return Promise.resolve(jsonRes({ error: { code: "NOT_FOUND", message: "unknown artifact" } }, 404));
    }
    // Unsupported routes (/intent/normalize, /catalog, /binding/resolve, /compose/stream, etc.) are 404.
    return Promise.resolve(jsonRes({ error: { code: "NOT_FOUND", message: `no route ${pathname}` } }, 404));
  };
  return { fetch: fetchImpl, composeIntent: { canonical: "sales.demo", params: {} } };
}

function pick(results: ConformanceResult[], id: string): ConformanceResult {
  const r = results.find((x) => x.id === id);
  if (r == null) throw new Error(`no ${id} in results`);
  return r;
}

const ARTIFACT = "sha256:abc";
const PASS_LINEAGE: LineageEvent[] = [
  {
    type: "component.reviewed",
    ts: "2026-07-02T00:00:01Z",
    actor: { kind: "user" },
    payload: { artifactId: ARTIFACT, decision: "approve" },
  },
  {
    type: "component.published",
    ts: "2026-07-02T00:00:02Z",
    actor: { kind: "system" },
    payload: { artifactId: ARTIFACT },
  },
];

describe("conformance REST new checks", () => {
  it("200 configuration: REST-ERR-001 / ERR-002 / LIN-001 / GOV-001 hold", async () => {
    const results = await runRestSuite(fakeTarget({ lineage: PASS_LINEAGE }));
    expect(pick(results, "REST-ERR-001").pass).toBe(true);
    expect(pick(results, "REST-ERR-002").pass).toBe(true);
    expect(pick(results, "REST-LIN-001").pass).toBe(true);
    const gov = pick(results, "REST-GOV-001");
    expect(gov.pass).toBe(true);
    expect(gov.skipped ?? false).toBe(false);
  });

  it("501 configuration: ERR-002 passes with a 501 envelope, GOV-001 is skipped", async () => {
    const results = await runRestSuite(fakeTarget({ lineage: [], governanceNotImpl: true }));
    expect(pick(results, "REST-ERR-002").pass).toBe(true);
    const gov = pick(results, "REST-GOV-001");
    expect(gov.pass).toBe(true);
    expect(gov.skipped).toBe(true);
  });

  it("LIN-PRM-001: holds when approve precedes published (not skipped)", async () => {
    const results = await runRestSuite(fakeTarget({ lineage: PASS_LINEAGE }));
    const lin = pick(results, "LIN-PRM-001");
    expect(lin.pass).toBe(true);
    expect(lin.skipped ?? false).toBe(false);
  });

  it("LIN-PRM-001: fails when there is no approve for published (pass=false)", async () => {
    const failLineage: LineageEvent[] = [
      {
        type: "component.published",
        ts: "2026-07-02T00:00:02Z",
        actor: { kind: "system" },
        payload: { artifactId: ARTIFACT },
      },
    ];
    const results = await runRestSuite(fakeTarget({ lineage: failLineage }));
    expect(pick(results, "LIN-PRM-001").pass).toBe(false);
  });

  it("LIN-PRM-001: skipped when published is absent (treated as pass but with detail)", async () => {
    const noPublish: LineageEvent[] = [{ type: "view.composed", ts: "2026-07-02T00:00:00Z", payload: {} }];
    const results = await runRestSuite(fakeTarget({ lineage: noPublish }));
    const lin = pick(results, "LIN-PRM-001");
    expect(lin.pass).toBe(true);
    expect(lin.skipped).toBe(true);
    expect(lin.detail).toContain("cannot check");
  });

  it("LIN-PRM-001: notChecked (not a pass) when GET /lineage itself is non-200", async () => {
    const results = await runRestSuite(fakeTarget({ lineage: [], lineageStatus: 503 }));
    const lin = pick(results, "LIN-PRM-001");
    expect(lin.notChecked).toBe(true);
    expect(lin.pass).toBe(false);
    expect(lin.skipped ?? false).toBe(false);
    expect(lin.detail).toContain("503");

    // A notChecked result must not count toward mustTotal/mustPassed (it would otherwise either masquerade
    // as a pass or block CONFORMANT on an unreachable dependency), and must surface via notCheckedMustIds
    // with its own reason rather than the generic "not checked (outside this suite)" text.
    const report = buildReport(results);
    expect(report.notCheckedMustIds).toContain("LIN-PRM-001");
    const formatted = formatReport(report);
    expect(formatted).toContain("LIN-PRM-001");
    expect(formatted).toContain("503");
    expect(formatted).not.toMatch(/✗ \[MUST\] LIN-PRM-001/);
  });
});

describe("buildReport (separation of verification categories)", () => {
  it("reference requirements go to referenceVerifiedIds, unchecked blackbox goes to notCheckedMustIds", () => {
    // Empty results = a suite that checked nothing.
    const report = buildReport([]);
    // MCP / sandbox are reference (guaranteed by reference-implementation tests).
    expect(report.referenceVerifiedIds).toContain("MCPAPP-RES-001");
    expect(report.referenceVerifiedIds).toContain("SBX-CSP-001");
    // SPEC / REST / LIN-PRM-001 are blackbox, so they fall on the unchecked side.
    expect(report.notCheckedMustIds).toContain("REST-ERR-001");
    expect(report.notCheckedMustIds).toContain("LIN-PRM-001");
    // Mutually exclusive (reference is not treated as unchecked).
    expect(report.notCheckedMustIds).not.toContain("MCPAPP-RES-001");
    expect(report.referenceVerifiedIds).not.toContain("REST-ERR-001");
  });
});
