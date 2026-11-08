import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  computeStructureHash,
  type DomainPort,
  type FilterDescriptor,
  type FixationRecord,
  finalizeIntent,
  type Scope,
  type SemanticPort,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// With ComposePolicy.l1Filters the finalized L1 Spec carries data.bind variants that the skeleton's
// refs-based capability does not cover. The generation path has no final `spec` event (skeleton -> patch* ->
// done), so the last convergence patch carries a replacement `capability` issued from the finalized Spec.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";
const VARIANT = "query://sales/summary?fy=2026&groupBy=product";

const GROUP_BY: FilterDescriptor = {
  param: "groupBy",
  queryParam: "groupBy",
  paths: ["summary"],
  label: "Group by",
  options: [
    { value: "region", label: "By region" },
    { value: "product", label: "By product" },
  ],
};

function semantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.summary", params, hash: "" };
    },
    async resolveQuery() {
      return [{ uri: REF }];
    },
    async dataVersion() {
      return "sales@v1";
    },
    async describeFilters() {
      return [GROUP_BY];
    },
  };
}

function storage(): StoragePort {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(k) {
      return cache.get(k) ?? null;
    },
    async putSpecCache(k, s) {
      cache.set(k, s);
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

function scopeAuthz(): AuthzPort {
  return {
    async issueCapability(_principal, scopes) {
      return Buffer.from(JSON.stringify(scopes)).toString("base64url");
    },
    async verify(token, req) {
      const scopes = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Scope[];
      const granted = scopes.some((s) => s.kind === req.kind && req.ref === s.ref);
      return granted
        ? { ok: true, principal: { id: "u", roles: ["user"] } }
        : { ok: false, reason: `scope does not cover ${req.kind}:${req.ref}` };
    },
  };
}

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke(op, args) {
    return { columns: [], rows: [], dataVersion: "sales@v1", op, args };
  },
};

function draft(): unknown {
  return {
    components: [
      { id: "root", type: "layout.stack", props: { direction: "vertical", gap: null }, children: ["h", "c"] },
      { id: "h", type: "text.heading", props: { level: 2, text: "Sales" } },
      {
        id: "c",
        type: "presentChart",
        props: { kind: "bar", x: "region", y: "revenue", series: null, stacked: null, title: null },
        children: null,
        data: { $ref: REF },
      },
    ],
    events: [],
  };
}

function makeApp(l1Filters: boolean): { app: ReturnType<typeof createKohakuRoutes>; llm: FakeLlm } {
  const llm = new FakeLlm({ objects: [draft()] });
  const compose: ComposeContext = {
    catalog,
    semantic: semantic(),
    storage: storage(),
    llm,
    policy: { l1Filters },
  };
  const deps: KohakuHostDeps = { compose, domain, authz: scopeAuthz(), querySource: "sales" };
  return { app: createKohakuRoutes(deps), llm };
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(sse: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of sse.split("\n\n")) {
    const lines = block.split("\n");
    const event = lines
      .find((l) => l.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    const data = lines.find((l) => l.startsWith("data:"));
    if (event == null || data == null) continue;
    out.push({ event, data: JSON.parse(data.slice("data:".length).trim()) as Record<string, unknown> });
  }
  return out;
}

async function stream(app: ReturnType<typeof createKohakuRoutes>): Promise<SseEvent[]> {
  const res = await app.request("/compose/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.summary", params: {} } }),
  });
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

async function resolveStatus(
  app: ReturnType<typeof createKohakuRoutes>,
  capability: string,
  ref: string,
): Promise<number> {
  const res = await app.request(`/binding/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${capability}` },
  });
  return res.status;
}

describe("/compose/stream with l1Filters: the final patch re-issues the capability for the bind variants", () => {
  it("the last patch carries a capability that resolves every variant; the skeleton's does not", async () => {
    const { app, llm } = makeApp(true);
    const events = await stream(app);

    const skeleton = events.find((e) => e.event === "spec")!;
    expect(skeleton.data["final"]).toBe(false);
    const skeletonCap = skeleton.data["capability"] as string;
    expect(await resolveStatus(app, skeletonCap, REF)).toBe(200);
    // The skeleton's refs-based capability does not know the filter variants.
    expect(await resolveStatus(app, skeletonCap, VARIANT)).toBe(403);

    const patches = events.filter((e) => e.event === "patch");
    const withCap = patches.filter((p) => p.data["capability"] != null);
    expect(withCap).toHaveLength(1);
    expect(patches.at(-1)).toBe(withCap[0]);
    const finalCap = withCap[0]!.data["capability"] as string;
    expect(await resolveStatus(app, finalCap, REF)).toBe(200);
    expect(await resolveStatus(app, finalCap, VARIANT)).toBe(200);

    // Changing the filter costs no model call: a single L1 generation served the whole stream.
    expect(llm.calls).toHaveLength(1);
    expect(events.at(-1)?.event).toBe("done");
    // done's shape is unchanged (REST-STR-003).
    expect(Object.keys(events.at(-1)!.data).sort()).toEqual(["cache", "specHash", "tier"]);
  });

  it("without l1Filters no patch carries a capability (the stream is unchanged)", async () => {
    const { app } = makeApp(false);
    const events = await stream(app);
    const patches = events.filter((e) => e.event === "patch");
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((p) => p.data["capability"] === undefined)).toBe(true);
  });
});

describe("l1Filters x the other delivery paths", () => {
  const body = JSON.stringify({ intent: { canonical: "sales.summary", params: {} } });
  const post = (app: ReturnType<typeof createKohakuRoutes>, path: string): Promise<Response> =>
    Promise.resolve(
      app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body }),
    );

  it("a stream cache hit delivers a final:true spec event whose capability already covers the variants", async () => {
    const { app, llm } = makeApp(true);
    await stream(app); // first stream: miss, populates the Spec cache
    const second = await stream(app);
    const first = second.find((e) => e.event === "spec")!;
    expect(first.data["final"]).toBe(true);
    const cap = first.data["capability"] as string;
    expect(await resolveStatus(app, cap, VARIANT)).toBe(200);
    // No convergence patch is needed (nor sent with a capability) on the fast path.
    expect(second.filter((e) => e.event === "patch")).toHaveLength(0);
    expect(llm.calls).toHaveLength(1);
  });

  it("a fixated injected Spec is delivered unchanged with a capability for its variants", async () => {
    const generated = makeApp(true);
    const res = await post(generated.app, "/compose");
    const { spec: injected } = (await res.json()) as { spec: UISpec };
    expect(injected.components.some((c) => c.type === "control.select")).toBe(true);

    const intent = await finalizeIntent({ canonical: "sales.summary", params: {} });
    const fixation: FixationRecord = {
      intentHash: intent.hash,
      canonical: "sales.summary",
      structureHash: await computeStructureHash(injected),
      pinnedSpec: injected,
      fixatedAt: "2026-06-10T00:00:00Z",
      approver: { id: "tester" },
      catalogFingerprint: catalog.fingerprint,
    };
    const llm = new FakeLlm({ objects: [] });
    const compose: ComposeContext = {
      catalog,
      semantic: semantic(),
      storage: storage(),
      llm,
      policy: { l1Filters: true },
    };
    const app = createKohakuRoutes({
      compose,
      domain,
      authz: scopeAuthz(),
      querySource: "sales",
      fixationLookup: async () => fixation,
    });
    const out = await post(app, "/compose");
    const delivered = (await out.json()) as { spec: UISpec; capability: string };
    expect(delivered.spec.provenance.cache).toBe("fixated");
    expect(delivered.spec.components).toEqual(injected.components);
    expect(delivered.spec.state).toEqual(injected.state);
    expect(await resolveStatus(app, delivered.capability, VARIANT)).toBe(200);
    expect(llm.calls).toHaveLength(0);
  });

  it("a fixated L0 pinnedSpec is delivered exactly as pinned with l1Filters on (no injection)", async () => {
    const pinned: UISpec = {
      kohaku: "0.2",
      intent: { canonical: "sales.summary", params: {}, hash: `sha256:${"0".repeat(64)}` },
      dataVersion: "ignored",
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["md1", "c1"] },
        { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
        { id: "c1", type: "presentChart", props: { kind: "bar" }, data: { $ref: REF } },
      ],
      events: [],
      provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
    };
    const intent = await finalizeIntent({ canonical: "sales.summary", params: {} });
    const fixation: FixationRecord = {
      intentHash: intent.hash,
      canonical: "sales.summary",
      structureHash: await computeStructureHash(pinned),
      pinnedSpec: pinned,
      fixatedAt: "2026-06-10T00:00:00Z",
      approver: { id: "tester" },
      catalogFingerprint: catalog.fingerprint,
    };
    const compose: ComposeContext = {
      catalog,
      semantic: semantic(),
      storage: storage(),
      llm: new FakeLlm({ objects: [] }),
      policy: { l1Filters: true },
    };
    const app = createKohakuRoutes({
      compose,
      domain,
      authz: scopeAuthz(),
      querySource: "sales",
      fixationLookup: async () => fixation,
    });
    const out = await post(app, "/compose");
    const delivered = (await out.json()) as { spec: UISpec };
    expect(delivered.spec.components.map((c) => c.id)).toEqual(["root", "md1", "c1"]);
    expect(delivered.spec.components.some((c) => c.type === "control.select")).toBe(false);
    expect(delivered.spec.state).toBeUndefined();
  });

  it("the convergence patch also carries the Governed Actions manifest and the write scopes of a form the model generated", async () => {
    const formDraft = {
      components: [
        {
          id: "root",
          type: "layout.stack",
          props: { direction: "vertical", gap: null },
          children: ["c", "f"],
        },
        {
          id: "c",
          type: "presentChart",
          props: { kind: "bar", x: "region", y: "revenue", series: null, stacked: null, title: null },
          children: null,
          data: { $ref: REF },
        },
        {
          id: "f",
          type: "presentForm",
          props: {
            action: "annotate",
            fields: [{ name: "note", type: "text", label: "Note" }],
            successMessage: null,
          },
          children: null,
        },
      ],
      events: [{ on: "f.submit", emit: "action.invoke", payload: [{ key: "note", value: "$value.note" }] }],
    };
    const writeDomain: DomainPort = {
      async listOperations() {
        return [{ name: "annotate", description: "Add a note", tier: "auto" }];
      },
      async invoke(op, args) {
        return { columns: [], rows: [], dataVersion: "sales@v1", op, args };
      },
    };
    const compose: ComposeContext = {
      catalog,
      semantic: semantic(),
      storage: storage(),
      llm: new FakeLlm({ objects: [formDraft] }),
      policy: { l1Filters: true },
    };
    const app = createKohakuRoutes({
      compose,
      domain: writeDomain,
      authz: scopeAuthz(),
      querySource: "sales",
    });
    const events = await stream(app);
    const skeleton = events.find((e) => e.event === "spec")!;
    expect(skeleton.data["actions"]).toBeUndefined();
    const last = events.filter((e) => e.event === "patch").at(-1)!;
    expect(typeof last.data["capability"]).toBe("string");
    expect(last.data["actions"]).toBeDefined();
    // The re-issued capability carries the write scope a non-stream compose of this Spec would issue.
    const write = await app.request("/binding/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${last.data["capability"] as string}`,
      },
      body: JSON.stringify({ action: "annotate", payload: { note: "hi" } }),
    });
    expect(write.status).toBe(200);
  });
});
