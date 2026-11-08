import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  FilterDescriptor,
  Scope,
  SemanticPort,
  StoragePort,
  UISpec,
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
    const event = lines.find((l) => l.startsWith("event:"))?.slice("event:".length).trim();
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
