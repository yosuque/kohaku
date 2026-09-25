# Path (c): the full stack — L1, L2, promotion, fixation, Admin

English | [日本語](full-stack.ja.md)

**Who this is for:** a product team that wants the model to compose screens from a governed catalog (L1), to invent new ones when the catalog falls short (L2), and a review loop that turns the good inventions into official parts — plus the audit trail to run it in production.

**Time:** about 30 minutes to a REST host that composes with your LLM; an afternoon to walk the promotion loop end to end with the sample.

## The first code: a governed REST host

```bash
npm install @kohaku-ui/host-rest @kohaku-ui/composer @kohaku-ui/registry @kohaku-ui/lineage @kohaku-ui/llm @kohaku-ui/spec-core hono @hono/node-server @ai-sdk/anthropic zod
npx @kohaku-ui/cli scaffold ports --out ./kohaku
```

```ts
import { serve } from "@hono/node-server";
import { createGovernancePolicy, createKohakuRoutes } from "@kohaku-ui/host-rest";
import { createFixations, createLineage, createPromotions, createViewRecorder } from "@kohaku-ui/lineage";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { Hono } from "hono";
import { fixedSpecs } from "./kohaku/fixed-specs.js"; // L0: screens that never touch the model
import * as ports from "./kohaku/ports.js"; // your four Ports (kohaku scaffold ports)

const { authzPort: authz, domainPort: domain, semanticPort: semantic, storagePort: storage } = ports;
const lineage = createLineage({ storage }); // every compose / review / fixation becomes an event
const promotions = createPromotions({ lineage, storage }); // L2 → L1 (add `judge` to score candidates)
const fixations = createFixations({ lineage, storage, policy: { minUses: 3 } }); // L1 → L0
const policy = { fixedSpecs, allowL2: true }; // the L0 shortcut, and permission to generate freely
const app = new Hono().route(
  "/api/kohaku",
  createKohakuRoutes({
    compose: { catalog: resolveCatalog(coreCatalog), semantic, storage, llm: createLlmFromEnv(), policy },
    domain,
    authz,
    querySource: "my-product",
    auth: async (c) => ({ id: "demo-admin", roles: [c.req.header("x-kohaku-role") ?? "admin"] }),
    authorizeGovernance: createGovernancePolicy({ roles: { admin: ["*"], viewer: ["lineage.read"] } }),
    recorder: createViewRecorder(lineage),
    promotions,
    fixations,
    fixationLookup: (intentHash, session) => storage.getFixation(intentHash, session.tenant),
  }),
);
serve({ fetch: app.fetch, port: 8787 });
```

`auth`'s `x-kohaku-role` header is a demo shortcut, the same one the bundled sample uses (`apps/sample-api/src/app/host-deps.ts`) — a real deployment resolves the principal and its roles from its own identity provider (JWT/OIDC, etc.), not a client-supplied header.

Point [Path (b)](react-dashboard.md)'s second snippet at it and the dashboard renders. Then `POST /compose` with `{ "input": { "kind": "nl", "text": "revenue by region as a bar chart" } }`: your `SemanticPort.normalize` maps the sentence to an Intent (the sample's LLM-backed implementation is `apps/sample-api/src/ports/semantic-port.ts`), and the composer either serves the fixed L0 Spec, composes an L1 Spec from the catalog, or — for a catch-all Intent your own SemanticPort routes to L2 (the sample's is `sales.custom`) — generates an L2 artifact that runs in the sandbox.

## The three tiers, in one host

| Tier | What decides | Where it is wired above |
|---|---|---|
| **L0 fixed** | `policy.fixedSpecs.lookup(intent)` returns a builder → no model call, `cache: "miss"` on the first compose, `"hit"` on an identical one | `fixedSpecs` |
| **L1 declarative** | The model picks parts from `catalog` and fills props; deterministic post-processing and a repair loop validate it against the catalog | `catalog`, `llm` |
| **L2 free** | `policy.allowL2` + an Intent routed to L2 (`routeTier`) → HTML/JS artifact, lint against the bridge contract, sandboxed render | `allowL2: true` |

## Promotion and fixation (the governance loop)

- Every compose is recorded by `recorder` into **lineage** (`view.composed`, `component.used`, …). `GET /lineage` and `GET /analytics/summary` read it back.
- An L2 artifact used often enough becomes a **promotion candidate** (`GET /promotions`, `POST /promotions/evaluate`). A reviewer previews the recorded artifact itself (`POST /promotions/:id/preview` — identical by sha256 to what users saw), fixes the schema (`componentType` / `intentName` / `description`) and approves (`POST /promotions/:id/approve`). Pass `judge` to `createPromotions` to have an LLM-as-Judge score candidates against a versioned rubric before a human sees them (`createJudge` from `@kohaku-ui/evals`; the sample's adapter is `apps/sample-api/src/app/promotions.ts`); the human approval step itself is never skipped.
- On publish, **your** `onPublish` (an option of `createPromotions`) adds the part to the catalog and the Intent to `SemanticPort` — the reference implementation is `apps/sample-api/src/intents/promoted-registry.ts`.
- Frequently used L1 Intents become **fixation proposals** (`GET /fixations/proposals`); `POST /fixations/approve` pins the Spec to L0 and the model is out of the loop for that screen. `fixationLookup` is what makes the host serve the pinned Spec, stamped `provenance.cache: "fixated"` — the one place that value comes from.
- `auth` + `authorizeGovernance` (`createGovernancePolicy`, a role → operation matrix) put RBAC on the governance routes: the snippet's `viewer: ["lineage.read"]` denies everything else, including `promotion.approve`, `promotion.reject` and `promotion.preview` — a `viewer` gets 403 on those. Without `authorizeGovernance` wired at all, every governance route is open to any caller (the host prints a startup warning saying so).

## Admin

The review UI (Lineage / Promotions / Fixations / Analytics tabs) currently lives in the sample web app, `apps/sample-web/src/pages/admin/` — copy it into your product for now; it talks to the routes above through `@kohaku-ui/client`. The [User guide §3](../user-guide.md#admin-governance-plane) describes each tab and [Demo 3](../user-guide.md#demo-3--l2-free-generation--promotion-the-true-forte-of-this-framework) walks the loop with the sample.

## Next steps

- Apply your design system to L2 output (tokens, a class vocabulary the model must stay within): [User guide §6, "Applying a design system to L2"](../user-guide.md#applying-a-design-system-to-l2).
- Golden regression for your Intents, so a prompt or model change cannot silently change a screen: [User guide §6, "Getting started with golden regression"](../user-guide.md#getting-started-with-golden-regression).
- Operations — cache sizing, cache-failure policy, deadlines, OTel traces: [User guide §7](../user-guide.md#7-operational-tips). The complete reference wiring is `apps/sample-api/src/app.ts`.
- The same host over MCP: [Path (a)](mcp-apps.md) reuses `compose`, `domain` and `authz` unchanged.
