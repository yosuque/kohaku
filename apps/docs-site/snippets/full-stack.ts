import { serve } from "@hono/node-server";
import { createKohakuRoutes } from "@kohaku-ui/host-rest";
import { createFixations, createLineage, createPromotions, createViewRecorder } from "@kohaku-ui/lineage";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { Hono } from "hono";
import { fixedSpecs } from "./kohaku/fixed-specs.js"; // L0: screens that never touch the model
import { authz, domain, semantic, storage } from "./kohaku/ports.js"; // your four Ports (kohaku scaffold ports)

const llm = createLlmFromEnv();
const lineage = createLineage({ storage }); // every compose / review / fixation becomes an event
const promotions = createPromotions({ lineage, storage }); // L2 → L1 (add `judge` to score candidates)
const fixations = createFixations({ lineage, storage, policy: { minUses: 3 } }); // L1 → L0
const policy = { fixedSpecs, allowL2: true }; // the L0 shortcut, and permission to generate freely
const app = new Hono().route(
  "/api/kohaku",
  createKohakuRoutes({
    compose: { catalog: resolveCatalog(coreCatalog), semantic, storage, llm, policy },
    domain,
    authz,
    querySource: "my-product",
    auth: async () => ({ id: "demo-admin", roles: ["admin"] }), // resolve from your JWT/OIDC in production
    recorder: createViewRecorder(lineage),
    promotions,
    fixations,
    fixationLookup: (intentHash, session) => storage.getFixation(intentHash, session.tenant),
  }),
);
serve({ fetch: app.fetch, port: 8787 });
