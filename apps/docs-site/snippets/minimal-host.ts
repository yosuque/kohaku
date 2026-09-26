import { serve } from "@hono/node-server";
import { createKohakuHost } from "@kohaku-ui/host";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { intents } from "./kohaku/intents.js"; // your hand-written Intent catalog (defineIntent)
import { domainPort as domain } from "./kohaku/ports.js"; // your DomainPort (kohaku scaffold ports)

const { app } = createKohakuHost({
  intents: intents.map((i) => i.toIntentDef()),
  domain,
  querySource: "my-product",
  llm: createLlmFromEnv(),
  dataVersion: () => "my-product@1",
});
serve({ fetch: app.fetch, port: 8787 });
