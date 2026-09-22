import { defaultLightTheme } from "@kohaku-ui/renderer-core";
import { RendererProvider, SpecView } from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import type { UISpec } from "@kohaku-ui/spec-core";

// An L0 Spec is data, not code: hand-write it today, serve it from your API tomorrow.
const ZERO_HASH = `sha256:${"0".repeat(64)}`; // a real host computes this from the canonical Intent
const spec: UISpec = {
  kohaku: "0.2",
  intent: { canonical: "demo.welcome", params: {}, hash: ZERO_HASH },
  dataVersion: "static@1",
  components: [
    { id: "root", type: "layout.stack", props: { direction: "vertical" }, children: ["title", "body"] },
    { id: "title", type: "text.heading", props: { level: 2, text: "Hello, kohaku" } },
    { id: "body", type: "presentMarkdown", props: { markdown: "This screen is **data**, not code." } },
  ],
  events: [],
  provenance: { tier: "L0", composedBy: "hand-written", cache: "bypass" },
};

export function Dashboard() {
  return (
    <RendererProvider value={{ impls: createCoreRegistry(), theme: defaultLightTheme }}>
      <SpecView spec={spec} />
    </RendererProvider>
  );
}
