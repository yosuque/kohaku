import { serve } from "@hono/node-server";
import { createKohakuHost } from "@kohaku-ui/host";
import { createGovernancePolicy } from "@kohaku-ui/host-rest";
import { createFixations, createLineage, createPromotions, createViewRecorder } from "@kohaku-ui/lineage";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { fixedSpecs } from "./kohaku/fixed-specs.js"; // L0: screens that never touch the model (hand-written)
import { intents } from "./kohaku/intents.js"; // written by kohaku scaffold ports
import { domainPort as domain } from "./kohaku/ports.js"; // written by kohaku scaffold ports

const storage = createMemoryStoragePort(); // the facade's default, created here so the services below share it
const lineage = createLineage({ storage }); // every compose / review / fixation becomes an event
const { app } = createKohakuHost({
  domain,
  storage,
  querySource: "my-product", // must equal the `source` of every Intent in intents.ts
  llm: createLlmFromEnv(),
  intents: intents.map((i) => i.toIntentDef()),
  dataVersion: () => "my-product@1",
  policy: { fixedSpecs, allowL2: true }, // the L0 shortcut, and permission to generate freely
  recorder: createViewRecorder(lineage),
  routes: {
    auth: async (c) => ({ id: "demo-admin", roles: [c.req.header("x-kohaku-role") ?? "admin"] }),
    authorizeGovernance: createGovernancePolicy({ roles: { admin: ["*"], viewer: ["lineage.read"] } }),
    promotions: createPromotions({ lineage, storage }), // L2 → L1 (add `judge` to score candidates)
    fixations: createFixations({ lineage, storage, policy: { minUses: 3 } }), // L1 → L0
    fixationLookup: (intentHash, session) => storage.getFixation(intentHash, session.tenant),
  },
});
serve({ fetch: app.fetch, port: 8787 });
