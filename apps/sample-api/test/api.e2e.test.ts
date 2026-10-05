import {
  createHmacApprovalPort,
  createHmacAuthzPort,
  createMemoryApprovalStore,
} from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type {
  FixationRecord,
  LineageEventRecord,
  SpecPatch,
  StoragePort,
  TabularData,
  UISpec,
} from "@kohaku-ui/spec-core";
import { actionPayloadHash, applyPatch, collectWriteActions, parseSpec } from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const SUMMARY_REF = "query://sales/summary?fy=2026&groupBy=region&q=3";
const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

// The "raw"-format draft of composer's L1 generation schema (for FakeLlm, targeting sales.trend)
function trendDraft(): unknown {
  return {
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: null },
        children: ["h", "c"],
      },
      { id: "h", type: "text.heading", props: { level: 2, text: "Monthly revenue trend" } },
      {
        id: "c",
        type: "presentChart",
        props: { kind: "bar", x: "month", y: "revenue", series: null, stacked: null, title: null },
        children: null,
        data: { $ref: TREND_REF },
      },
    ],
    events: [],
  };
}

async function makeTestApp(objects: unknown[] = [], storage: StoragePort = makeMemoryStorage()) {
  const llm = new FakeLlm({ objects });
  const authz = createHmacAuthzPort("test-secret");
  // Governed actions (design.md #62/#63): wired by default so every test exercises the same shape the
  // real demo does (index.ts wires createHmacApprovalPort the same way, off the same secret, with an
  // in-process ApprovalStore so an approval token is single-use).
  const approvals = createHmacApprovalPort("test-secret", { store: createMemoryApprovalStore() });
  return { ...(await createApp({ llm, storage, authz, approvals })), llm };
}

function makeMemoryStorage() {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(key: string) {
      return cache.get(key) ?? null;
    },
    async putSpecCache(key: string, spec: UISpec) {
      cache.set(key, spec);
    },
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

import type { Hono } from "hono";

async function composeJson(app: Hono, body: unknown) {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as { spec: UISpec; capability: string } };
}

const QUARTERLY_GUI = {
  input: {
    kind: "gui",
    action: "view.select",
    params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
};

/** Parse an SSE response into a {event, data} sequence (for tests). */
async function readSse(res: Response): Promise<{ event: string; data: string }[]> {
  const text = await res.text();
  const out: { event: string; data: string }[] = [];
  let event = "";
  let dataLines: string[] = [];
  const flush = (): void => {
    if (event !== "" || dataLines.length > 0) {
      out.push({ event, data: dataLines.join("\n") });
      event = "";
      dataLines = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      flush();
      continue;
    }
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  flush();
  return out;
}

async function streamCompose(app: Hono, body: unknown): Promise<Response> {
  return app.request("/api/kohaku/compose/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sample-api E2E", () => {
  it("standard views are L0 fixed Specs — compose and binding resolution pass without an LLM", async () => {
    const { app, llm } = await makeTestApp();

    const { res, json } = await composeJson(app, QUARTERLY_GUI);
    expect(res.status).toBe(200);
    const { spec, capability } = json;

    expect(spec.intent.canonical).toBe("sales.quarterly_summary");
    expect(spec.provenance.tier).toBe("L0");
    expect(llm.calls).toHaveLength(0); // no LLM invocation (adoption ladder Step 0)
    expect(spec.components.map((c) => c.id)).toEqual(["root", "title1", "chart1", "table1"]);
    expect(spec.components[1]!.props["text"]).toBe("FY2026 Q3 Sales (by Region)");

    const ref = spec.components[2]!.data!.$ref;
    expect(ref).toBe(SUMMARY_REF);

    const dataRes = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(ref)}`, {
      headers: { authorization: `Bearer ${capability}` },
    });
    expect(dataRes.status).toBe(200);
    const data = (await dataRes.json()) as TabularData;
    expect(data.columns.map((c) => c.key)).toEqual(["region", "revenue", "units"]);
    expect(data.rows).toHaveLength(4);
    expect(data.dataVersion).toBe(spec.dataVersion);
    const total = data.rows.reduce((s, r) => s + (r["revenue"] as number), 0);
    expect(total).toBeGreaterThan(1_000_000_000);
  });

  it("sales.trend is L1 — the LLM composes declaratively and deterministic post-processing corrects the time series to a line", async () => {
    const { app, llm } = await makeTestApp([trendDraft()]);
    const { json } = await composeJson(app, {
      input: { kind: "gui", action: "view.select", params: { intent: "sales.trend" } },
    });

    expect(json.spec.provenance.tier).toBe("L1");
    expect(llm.calls).toHaveLength(1);
    const chart = json.spec.components.find((c) => c.type === "presentChart")!;
    // The LLM chose bar, but the chartKind rule (x is time) overrides it to line
    expect(chart.props["kind"]).toBe("line");
    expect(chart.data?.$ref).toBe(TREND_REF);
  });

  it("no capability returns 401, an out-of-scope ref returns 403", async () => {
    const { app } = await makeTestApp();
    const res401 = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(SUMMARY_REF)}`);
    expect(res401.status).toBe(401);

    const { json } = await composeJson(app, QUARTERLY_GUI);
    const res403 = await app.request(
      `/api/kohaku/binding/resolve?ref=${encodeURIComponent("query://sales/records?limit=10")}`,
      { headers: { authorization: `Bearer ${json.capability}` } },
    );
    expect(res403.status).toBe(403);
  });

  it("/binding/action (annotate) returns actionEffects invalidates/refVersions, and re-resolution advances the data version", async () => {
    const { app } = await makeTestApp();
    // Writing requires a write-scoped capability (compose-derived is read-only). Issue one with the same secret.
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability({ id: "demo-user", roles: ["user"] }, [
      { kind: "write", ref: "annotate" },
      { kind: "read", ref: SUMMARY_REF },
    ]);

    const res = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" },
      body: JSON.stringify({
        action: "annotate",
        payload: { note: "test note", refs: [SUMMARY_REF] },
        // annotate is tier "confirm" (design.md #62/#63): the demo's DomainPort requires a same-request
        // confirmed: true before invoking (see apps/sample-api/src/domain/port.ts).
        confirmed: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { ok: boolean; dataVersion: string };
      invalidates: string[];
      refVersions: Record<string, string>;
    };
    expect(body.result.ok).toBe(true);
    // Side-effect declaration: invalidate the specified ref with a new data version
    expect(body.invalidates).toEqual([SUMMARY_REF]);
    expect(body.refVersions[SUMMARY_REF]).toBe(body.result.dataVersion);

    // Re-resolving actually shows the data version has advanced (matches the version bumped by annotate = the reconciliation target of the small loop)
    const dataRes = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(SUMMARY_REF)}`, {
      headers: { authorization: `Bearer ${cap}` },
    });
    const data = (await dataRes.json()) as TabularData;
    expect(data.dataVersion).toBe(body.result.dataVersion);
  });

  it("sales.records L0 fixed Spec has an annotate form, and the write loop runs with only the compose-derived capability", async () => {
    const { app, llm } = await makeTestApp();
    const { res, json } = await composeJson(app, {
      input: { kind: "gui", action: "view.select", params: { intent: "sales.records" } },
    });
    expect(res.status).toBe(200);
    const { spec, capability } = json;
    expect(spec.provenance.tier).toBe("L0");
    expect(llm.calls).toHaveLength(0); // no LLM invocation

    // presentForm (annotate) + an action.invoke event are declared (the write-loop UI).
    const form = spec.components.find((c) => c.type === "presentForm")!;
    expect(form.props["action"]).toBe("annotate");
    const submit = spec.events.find((e) => e.emit === "action.invoke")!;
    expect(submit.on).toBe(`${form.id}.submit`);
    const table = spec.components.find((c) => c.type === "presentSpreadsheet")!;
    const tableRef = table.data!.$ref;
    // payload.refs is the $ref of the table below (the invalidation target of actionEffects), and note is a single-field extraction template.
    expect((submit.payload as { refs: string[]; note: string }).refs).toEqual([tableRef]);
    expect((submit.payload as { note: string }).note).toBe("$value.note");

    // The table serves server-side paging (sort/paging round-trip through the reserved
    // _sort/_dir/_cursor/_limit params instead of a one-shot full fetch); pageSize mirrors the
    // records intent's `limit` param, which defaults to 100.
    expect(table.props["serverSide"]).toBe(true);
    expect(table.props["pageSize"]).toBe(100);

    // Without a manually issued write capability, writing goes through with only the capability returned by compose
    // (issueCapabilityForSpec attaches a write scope to the declared action).
    const writeRes = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({
        action: "annotate",
        payload: { note: "North America needs review", refs: [tableRef] },
        confirmed: true,
      }),
    });
    expect(writeRes.status).toBe(200);
    const writeBody = (await writeRes.json()) as {
      result: { dataVersion: string; notes: number };
      invalidates: string[];
      refVersions: Record<string, string>;
    };
    expect(writeBody.result.notes).toBe(1);
    expect(writeBody.invalidates).toEqual([tableRef]);
    expect(writeBody.refVersions[tableRef]).toBe(writeBody.result.dataVersion);

    // Re-resolving the table with the same capability shows the data version has advanced to the post-annotate version (the reconciliation target of the small loop).
    const dataRes = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(tableRef)}`, {
      headers: { authorization: `Bearer ${capability}` },
    });
    expect(dataRes.status).toBe(200);
    expect(((await dataRes.json()) as TabularData).dataVersion).toBe(writeBody.result.dataVersion);

    // Server-side paging/sort: the same compose-derived capability resolves the table's base ref with the
    // reserved _limit/_sort/_dir params merged in (capability validation is against the base ref, with
    // reserved params split off — see host-core's binding-ref.ts), returning a 10-row page sorted by
    // revenue descending, with a nextCursor since more than 10 of the 576 seed rows remain.
    const pagedRes = await app.request(
      `/api/kohaku/binding/resolve?ref=${encodeURIComponent(`${tableRef}&_limit=10&_sort=revenue&_dir=desc`)}`,
      { headers: { authorization: `Bearer ${capability}` } },
    );
    expect(pagedRes.status).toBe(200);
    const pagedData = (await pagedRes.json()) as TabularData;
    expect(pagedData.rows).toHaveLength(10);
    expect(pagedData.nextCursor).toBeDefined();
  });

  it("governed actions: annotate (tier confirm) rejects without confirmed:true, then succeeds with it (design.md #62/#63)", async () => {
    const { app } = await makeTestApp();
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability({ id: "demo-user", roles: ["user"] }, [
      { kind: "write", ref: "annotate" },
    ]);
    const noConfirm = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "annotate", payload: { note: "test note" } }),
    });
    expect(noConfirm.status).toBe(403);
    const noConfirmBody = (await noConfirm.json()) as {
      error: { code: string; approval: { action: string; tier: string } };
    };
    expect(noConfirmBody.error.code).toBe("APPROVAL_REQUIRED");
    expect(noConfirmBody.error.approval).toMatchObject({ action: "annotate", tier: "confirm" });

    const confirmed = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "annotate", payload: { note: "test note" }, confirmed: true }),
    });
    expect(confirmed.status).toBe(200);
  });

  it("governed actions: annotate rejects a note over 500 characters with 422 ACTION_PARAMS_INVALID, before invoking (design.md #62)", async () => {
    const { app } = await makeTestApp();
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability({ id: "demo-user", roles: ["user"] }, [
      { kind: "write", ref: "annotate" },
    ]);
    const res = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "annotate", payload: { note: "x".repeat(501) }, confirmed: true }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; issues: { path: string; code: string }[] } };
    expect(body.error.code).toBe("ACTION_PARAMS_INVALID");
    expect(body.error.issues).toEqual([{ path: "note", code: "maxLength", message: expect.any(String) }]);
  });

  it("governed actions: publish rejects a payload with an extra key with 422 ACTION_PARAMS_INVALID, before the approval gate", async () => {
    const { app } = await makeTestApp();
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability({ id: "demo-user", roles: ["user"] }, [
      { kind: "write", ref: "publish" },
    ]);
    const res = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", payload: { action: "publish", extra: 1 } }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; issues: { path: string; code: string }[] } };
    expect(body.error.code).toBe("ACTION_PARAMS_INVALID");
    expect(body.error.issues).toEqual([
      { path: "extra", code: "additionalProperties", message: expect.any(String) },
    ]);
  });

  it("governed actions: publish (tier approve) requires a bound approval token issued to a different principal (design.md #62/#63)", async () => {
    // A real (in-memory) StoragePort, not the stub: this test reads the action audit trail back from lineage.
    const { app } = await makeTestApp([], createMemoryStoragePort());
    const authz = createHmacAuthzPort("test-secret");
    // The requester's capability, distinct from the approver identity used below.
    const requesterCap = await authz.issueCapability({ id: "demo-user", roles: ["user"] }, [
      { kind: "write", ref: "publish" },
    ]);
    const payload = { action: "publish" };

    const noApproval = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${requesterCap}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", payload }),
    });
    expect(noApproval.status).toBe(403);
    const noApprovalBody = (await noApproval.json()) as {
      error: {
        code: string;
        approval: { requestId: string; action: string; tier: string; payloadHash: string };
      };
    };
    expect(noApprovalBody.error.code).toBe("APPROVAL_REQUIRED");
    expect(noApprovalBody.error.approval).toMatchObject({ action: "publish", tier: "approve" });

    // The refused attempt is on the audit trail, which is what the console's Approvals inbox derives its
    // pending list from (design.md #72): one "approve"-tier approvalRequested, attributed to the requester
    // (actor.id = the capability's principal) with the payload recorded (host-deps.ts: recordPayload, demo only).
    const requestedRes = await app.request("/api/kohaku/lineage?type=action.approvalRequested&limit=1000");
    expect(requestedRes.status).toBe(200);
    const requested = ((await requestedRes.json()) as { events: LineageEventRecord[] }).events.filter(
      (e) => e.payload.tier === "approve",
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      type: "action.approvalRequested",
      actor: { kind: "user", id: "demo-user" },
      payload: {
        action: "publish",
        payloadHash: await actionPayloadHash(payload),
        tier: "approve",
        requestId: noApprovalBody.error.approval.requestId,
        payload,
      },
    });

    const approvalBody = async (requesterId: string) =>
      JSON.stringify({ action: "publish", payloadHash: await actionPayloadHash(payload), requesterId });
    const issueAs = async (role: string, requesterId: string) =>
      app.request("/api/kohaku/approvals", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kohaku-role": role },
        body: await approvalBody(requesterId),
      });

    // Only roles holding action.approve can mint a token: a viewer (the usual requester in the demo) cannot,
    // and an approver cannot approve their own request (admin = "demo-admin" approving "demo-admin" is 400).
    expect((await issueAs("viewer", "demo-user")).status).toBe(403);
    expect((await issueAs("admin", "demo-admin")).status).toBe(400);

    // The demo's "approver" role (id "demo-approver", distinct from the "demo-user" requester above) holds
    // action.approve — see apps/sample-api/src/app/host-deps.ts's authorizeGovernance.
    const approveRes = await issueAs("approver", "demo-user");
    expect(approveRes.status).toBe(200);
    const { approval } = (await approveRes.json()) as { approval: string };
    expect(approval.startsWith("kohaku-approval.v2.")).toBe(true);

    const approved = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${requesterCap}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", payload, approval }),
    });
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { result: { ok: boolean; published: number } };
    expect(approvedBody.result.ok).toBe(true);
    expect(approvedBody.result.published).toBe(1);

    // Consuming the token is audited: action.approved names both principals, which is what settles the
    // pending row in the inbox (the invoke itself is an action.invoked of the same tier).
    const approvedEvents = (
      (await (await app.request("/api/kohaku/lineage?type=action.approved&limit=1000")).json()) as {
        events: LineageEventRecord[];
      }
    ).events;
    expect(approvedEvents).toHaveLength(1);
    expect(approvedEvents[0]).toMatchObject({
      type: "action.approved",
      payload: {
        action: "publish",
        payloadHash: await actionPayloadHash(payload),
        approverId: "demo-approver",
        requesterId: "demo-user",
      },
    });

    // The demo wires an in-process ApprovalStore (index.ts), so the token is single-use (design.md #63): the
    // identical (action, payload, requester) triple needs a new approval for a second invoke, which is what
    // the console's Re-issue is for.
    const replay = await app.request("/api/kohaku/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${requesterCap}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", payload, approval }),
    });
    expect(replay.status).toBe(403);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("APPROVAL_REQUIRED");
  });

  it("a composed sales.records Spec declares the publish write, so the compose-derived capability can invoke it", async () => {
    const { app } = await makeTestApp();
    const { json } = await composeJson(app, {
      input: { kind: "gui", action: "view.select", params: { intent: "sales.records" } },
    });
    // The action name has to survive the compose post-processing (action.button's propsSchema has no `action`,
    // so it travels in the event payload); otherwise the write scope is never issued and the Publish button
    // cannot reach the approval gate at all.
    expect(collectWriteActions(json.spec).sort()).toEqual(["annotate", "publish"]);
  });

  it("governed actions: the approval round trip starting from a viewer compose (the Demo 5 flow, requester demo-viewer)", async () => {
    const { app } = await makeTestApp([], createMemoryStoragePort());
    const asRole = (role: string) => ({ "content-type": "application/json", "x-kohaku-role": role });

    // The requester is whoever composed: the capability's principal is the role of the compose request.
    const composed = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: asRole("viewer"),
      body: JSON.stringify({
        input: { kind: "gui", action: "view.select", params: { intent: "sales.records" } },
      }),
    });
    expect(composed.status).toBe(200);
    const { spec, capability } = (await composed.json()) as { spec: UISpec; capability: string };
    // What the renderer sends on a Publish press: the event payload as declared (it carries the action name).
    const publishEvent = spec.events.find((e) => e.emit === "action.invoke" && e.on.endsWith(".press"))!;
    const payload = publishEvent.payload as Record<string, unknown>;
    expect(payload).toEqual({ action: "publish" });
    const invokePublish = async (approval?: string) =>
      app.request("/api/kohaku/binding/action", {
        method: "POST",
        headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "publish", payload, ...(approval != null ? { approval } : {}) }),
      });

    // First press: no token yet -> 403 APPROVAL_REQUIRED with the request descriptor.
    const first = await invokePublish();
    expect(first.status).toBe(403);
    const { error } = (await first.json()) as {
      error: { code: string; approval: { requestId: string; payloadHash: string } };
    };
    expect(error.code).toBe("APPROVAL_REQUIRED");

    // The refused attempt is on the audit trail, attributed to the viewer (what the inbox lists).
    const requested = (
      (await (await app.request("/api/kohaku/lineage?type=action.approvalRequested&limit=1000")).json()) as {
        events: LineageEventRecord[];
      }
    ).events.filter((e) => e.payload.tier === "approve");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.actor.id).toBe("demo-viewer");
    expect(requested[0]!.payload["requestId"]).toBe(error.approval.requestId);

    // The approver mints the token for exactly that (action, payloadHash, requester).
    const issued = await app.request("/api/kohaku/approvals", {
      method: "POST",
      headers: asRole("approver"),
      body: JSON.stringify({
        action: "publish",
        payloadHash: error.approval.payloadHash,
        requesterId: "demo-viewer",
      }),
    });
    expect(issued.status).toBe(200);
    const { approval } = (await issued.json()) as { approval: string };

    // Second press: the viewer carries the token and the write goes through.
    const second = await invokePublish(approval);
    expect(second.status).toBe(200);

    const settled = (
      (await (await app.request("/api/kohaku/lineage?type=action.approved&limit=1000")).json()) as {
        events: LineageEventRecord[];
      }
    ).events;
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      action: "publish",
      approverId: "demo-approver",
      requesterId: "demo-viewer",
    });
  });

  it("the second compose of the same Intent is a cache hit", async () => {
    const { app } = await makeTestApp();
    const first = (await composeJson(app, QUARTERLY_GUI)).json;
    const second = (await composeJson(app, QUARTERLY_GUI)).json;

    expect(first.spec.provenance.cache).toBe("miss");
    expect(second.spec.provenance.cache).toBe("hit");
    expect(second.spec.intent.hash).toBe(first.spec.intent.hash);
    expect(second.spec.components).toEqual(first.spec.components);
  });

  it("chat (NL) yields the same Spec as GUI for the same Intent", async () => {
    // Script only the LLM response for NL normalization (composition is L0 + cache)
    const { app, llm } = await makeTestApp([
      { intent: "sales.quarterly_summary", params: { fiscalYear: 2026, quarter: 3, groupBy: "region" } },
    ]);

    const fromGui = (await composeJson(app, QUARTERLY_GUI)).json;
    const fromNl = (
      await composeJson(app, {
        input: { kind: "nl", text: "FY2026 Q3 sales by region as a chart" },
        session: { surface: "chat" },
      })
    ).json;

    expect(fromNl.spec.intent.hash).toBe(fromGui.spec.intent.hash);
    expect(fromNl.spec.provenance.cache).toBe("hit");
    expect(fromNl.spec.components).toEqual(fromGui.spec.components);
    expect(llm.calls.filter((c) => c.kind === "object")).toHaveLength(1); // NL normalization only
  });

  it("a row click swaps to drilldown (region filter + by product)", async () => {
    const { app } = await makeTestApp();
    const first = (await composeJson(app, QUARTERLY_GUI)).json;

    const eventRes = await app.request("/api/kohaku/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: { canonical: first.spec.intent.canonical, params: first.spec.intent.params },
        event: { on: "table1.rowClick", payload: { drilldown: "japan" } },
      }),
    });
    expect(eventRes.status).toBe(200);
    const { spec } = (await eventRes.json()) as { spec: UISpec };
    expect(spec.intent.params["region"]).toBe("japan");
    expect(spec.intent.params["groupBy"]).toBe("product");
    // Filtering to a region yields a region cross-filter: a heading + control.select + region-bound
    // chart/table. Keeping the drilldown's correctness (region=japan / groupBy=product), subsequent region switching
    // can be done without a compose round-trip (a quarterly_summary with region returns a cross-filter Spec).
    expect(spec.components[1]!.props["text"]).toBe("FY2026 Q3 Region cross-filter (breakdown by Product)");
    expect(spec.components.some((c) => c.type === "control.select")).toBe(true);
    expect(spec.state).toEqual({ region: "japan" });
  });

  it("/api/health and bump-data-version (cache invalidation)", async () => {
    const { app } = await makeTestApp();
    const health = (await (await app.request("/api/health")).json()) as {
      ok: boolean;
      seed: { records: number };
    };
    expect(health.ok).toBe(true);
    expect(health.seed.records).toBe(576);

    const before = (await composeJson(app, QUARTERLY_GUI)).json;
    await app.request("/api/kohaku/admin/bump-data-version", { method: "POST" });
    const after = (await composeJson(app, QUARTERLY_GUI)).json;

    // When dataVersion advances, the cache key changes and it re-composes (miss)
    expect(before.spec.dataVersion).not.toBe(after.spec.dataVersion);
    expect(after.spec.provenance.cache).toBe("miss");
  });

  // The demo cache-busting route was moved under /api/kohaku/* (identity middleware + governance RBAC) so it
  // is no longer reachable without a role that is authorized for admin.bumpDataVersion (previously anyone could
  // hit it to force cache invalidation / LLM spend). See governance-role.e2e.test.ts for the RBAC matrix.
  it("bump-data-version: admin succeeds with {dataVersion}, viewer is denied, and the old path is gone", async () => {
    const { app, repo } = await makeTestApp();

    const asAdmin = await app.request("/api/kohaku/admin/bump-data-version", {
      method: "POST",
      headers: { "x-kohaku-role": "admin" },
    });
    expect(asAdmin.status).toBe(200);
    expect(((await asAdmin.json()) as { dataVersion: string }).dataVersion).toBe(repo.dataVersion());

    const asViewer = await app.request("/api/kohaku/admin/bump-data-version", {
      method: "POST",
      headers: { "x-kohaku-role": "viewer" },
    });
    expect(asViewer.status).toBe(403);
    expect(((await asViewer.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");

    const oldPath = await app.request("/api/admin/bump-data-version", { method: "POST" });
    expect(oldPath.status).toBe(404);
  });

  it("unfixate: a StoragePort without deleteFixation returns 501 NOT_IMPLEMENTED", async () => {
    const llm = new FakeLlm({ objects: [] });
    const authz = createHmacAuthzPort("test-secret");
    const stubFixation: FixationRecord = {
      intentHash: "sha256:" + "2".repeat(64),
      canonical: "sales.trend",
      structureHash: "sha256:" + "3".repeat(64),
      pinnedSpec: {
        kohaku: "0.1",
        intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "2".repeat(64) },
        dataVersion: "sales@seed-1",
        components: [{ id: "root", type: "layout.stack", props: {} }],
        events: [],
        provenance: { tier: "L0", composedBy: "test", cache: "hit" },
      },
      fixatedAt: new Date().toISOString(),
      approver: { id: "demo-admin" },
    };
    // getFixation returns a record but deleteFixation is unimplemented -> unfixate is fail-fast (FIXATION_UNSUPPORTED)
    const storage = {
      ...makeMemoryStorage(),
      async getFixation() {
        return stubFixation;
      },
    };
    const { app } = await createApp({ llm, storage, authz });

    const res = await app.request("/api/kohaku/fixations/test-hash/remove", { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });
});

describe("sample-api /compose/stream (SSE streaming)", () => {
  it("an L0 fixed Spec emits one final:true event + done (no LLM, data resolvable via capability)", async () => {
    const { app, llm } = await makeTestApp();
    const res = await streamCompose(app, QUARTERLY_GUI);
    expect(res.status).toBe(200);

    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["spec", "done"]);

    const specData = JSON.parse(events[0]!.data) as { spec: unknown; capability: string; final: boolean };
    expect(specData.final).toBe(true);
    expect(specData.capability.length).toBeGreaterThan(0);
    const spec = parseSpec(specData.spec);
    expect(spec.provenance.tier).toBe("L0");
    expect(llm.calls).toHaveLength(0);

    const doneData = JSON.parse(events[1]!.data) as { specHash: string; tier: string; cache: string };
    expect(doneData.tier).toBe("L0");
    expect(doneData.specHash).toMatch(/^sha256:/);

    // The issued capability can resolve the spec's $ref (the issued refs cover the spec's $ref)
    const ref = spec.components.find((c) => c.data != null)!.data!.$ref;
    const dataRes = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(ref)}`, {
      headers: { authorization: `Bearer ${specData.capability}` },
    });
    expect(dataRes.status).toBe(200);
  });

  it("L1 emits a skeleton (final:false, ui.loading) -> patch -> done, and patch application matches the non-streaming /compose", async () => {
    const { app } = await makeTestApp([trendDraft()]);
    const body = { input: { kind: "gui", action: "view.select", params: { intent: "sales.trend" } } };

    const res = await streamCompose(app, body);
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["spec", "patch", "done"]);

    const specData = JSON.parse(events[0]!.data) as { spec: unknown; capability: string; final: boolean };
    expect(specData.final).toBe(false);
    expect(specData.capability.length).toBeGreaterThan(0);
    let spec = parseSpec(specData.spec);
    expect(spec.components.some((c) => c.type === "ui.loading")).toBe(true);

    const patchData = JSON.parse(events[1]!.data) as { patch: SpecPatch };
    spec = applyPatch(spec, patchData.patch);
    expect(spec.components.some((c) => c.type === "ui.loading")).toBe(false);

    const doneData = JSON.parse(events[2]!.data) as { tier: string };
    expect(doneData.tier).toBe("L1");

    // components/events match the non-streaming /compose (a cache hit at this point) (equivalence)
    const plain = (await composeJson(app, body)).json;
    expect(spec.components).toEqual(plain.spec.components);
    expect(spec.events).toEqual(plain.spec.events);
  });

  it("an invalid body returns a 400 envelope before the stream starts (does not begin SSE)", async () => {
    const { app } = await makeTestApp();
    const res = await streamCompose(app, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// Regression for observability-hook wiring: since app.ts wired host-rest's onError, on the failure path
// a requestId is issued and carried in the error response's error.requestId, and the same requestId also appears in
// the console log (so the log and the client's error can be correlated).
describe("failure-path observability (onError wiring)", () => {
  it("a normalization failure (422) error response carries requestId and can be correlated with console logs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app } = await makeTestApp();
      const res = await app.request("/api/kohaku/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { kind: "gui", action: "view.select", params: { intent: "unknown.intent" } },
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; requestId?: string } };
      expect(body.error.code).toBe("INTENT_INVALID");
      // The onError wiring issues a requestId (not present when unwired).
      expect(typeof body.error.requestId).toBe("string");
      expect(body.error.requestId!.length).toBeGreaterThan(0);
      // The same requestId appears in the console.error log (demonstrating correlation).
      const logged = errorSpy.mock.calls.some((args) => String(args[0]).includes(body.error.requestId!));
      expect(logged).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Body size limit (ops; product responsibility — host-rest itself imposes none, see app.ts's bodyLimit wiring).
describe("request body size limit", () => {
  it("a 2 MiB compose body is rejected with 413 before it reaches Intent resolution", async () => {
    const { app } = await makeTestApp();
    // Pad an otherwise-valid /compose body past the 1 MiB cap with a long string parameter.
    const oversizedBody = JSON.stringify({
      intent: {
        canonical: "sales.trend",
        params: { padding: "x".repeat(2 * 1024 * 1024) },
      },
    });
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: "BAD_REQUEST", message: "request body too large" });
  });

  it("a normal-sized compose body is not affected by the size limit", async () => {
    const { app } = await makeTestApp([trendDraft()]);
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { kind: "nl", text: "monthly revenue trend" } }),
    });
    expect(res.status).toBe(200);
  });
});
