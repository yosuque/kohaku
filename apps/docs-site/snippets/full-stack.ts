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
