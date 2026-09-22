# Path (b): a React dashboard, no LLM

English | [日本語](react-dashboard.ja.md)

**Who this is for:** a product team that wants Server-Driven UI now and LLM composition later (or never). You write a UI Spec by hand or serve it from your API; `@kohaku-ui/renderer-react` draws it. Nothing in this path calls a model.

**Time:** about 10 minutes to the first screen, 20 to a screen fed by a running host.

## 1. Render a Spec (no server)

```bash
npm install @kohaku-ui/renderer-react @kohaku-ui/renderer-core @kohaku-ui/spec-core react react-dom zod
```

```tsx
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
```

Mount `<Dashboard />` with `createRoot` as usual. What you just did: the screen is a JSON document validated by `@kohaku-ui/spec-core`; the 15 core parts (`layout.*`, `text.heading`, `presentChart`, `presentSpreadsheet`, `presentForm`, …) are implemented once in `@kohaku-ui/renderer-react/core` and rendered identically by the Web Components renderer and the MCP Apps widget. The theme is a token map (`defaultLightTheme` / `defaultDarkTheme`); swap or override tokens and every part follows.

## 2. Feed it from a host (data by reference)

Charts and tables carry a `query://` **reference**, never rows. The host that composed the Spec also issues a short-lived capability for exactly those references, and the components fetch through it. Start the bundled sample host (`pnpm dev` in the repository, API on `:8787`) or your own (see [Path (c)](full-stack.md)), then:

```bash
npm install @kohaku-ui/client @kohaku-ui/data-binding
```

```tsx
import { createKohakuClient } from "@kohaku-ui/client";
import { createBindingClient } from "@kohaku-ui/data-binding";
import { defaultLightTheme } from "@kohaku-ui/renderer-core";
import { RendererProvider, SpecView } from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import type { UISpec } from "@kohaku-ui/spec-core";
import { useEffect, useState } from "react";

const BASE_URL = "http://localhost:8787/api/kohaku"; // any kohaku REST host (pnpm dev, or your own)
const client = createKohakuClient({ baseUrl: BASE_URL });
const impls = createCoreRegistry();
const intent = { canonical: "sales.quarterly_summary", params: { fiscalYear: 2026, quarter: 3 } };

export function Dashboard() {
  const [view, setView] = useState<{ spec: UISpec; capability: string } | null>(null);
  // A GUI request: the host normalizes it to a canonical Intent and answers with the (cached) Spec.
  useEffect(() => void client.compose({ intent }).then(setView), []);
  if (view == null) return <p>Loading…</p>;
  // Components fetch their own data by reference, with the capability the host issued for this Spec.
  const binding = createBindingClient({ baseUrl: BASE_URL, capability: view.capability });
  return (
    <RendererProvider value={{ impls, binding, theme: defaultLightTheme }}>
      <SpecView spec={view.spec} />
    </RendererProvider>
  );
}
```

Open the network tab: `POST /compose` returns `{spec, capability}` with **zero numbers in the Spec**; the chart's `GET /binding/resolve` carries the capability as a Bearer token and returns the rows. Send the same request twice and the second response is `provenance.cache: "hit"` — that is the identical-display guarantee at work.

## Where this leads

- **Your own L0 screens on your own data**: implement the four Ports (`node cli/bin/kohaku.js scaffold ports` gives you the file) and register your fixed Specs in `policy.fixedSpecs` — [User guide §6, Step 0](../user-guide.md#step-0--server-driven-ui-without-an-llm).
- **Events and drill-down**: declare `events` on the Spec (`table1.rowClick → intent.patch`) and pass `onEvent` to `RendererProvider`; the host recomposes — [User guide, Demo 4](../user-guide.md#demo-4--interaction-loop-and-fixation).
- **Let the model compose within your catalog (L1)**: [Path (c)](full-stack.md).
- **The same Spec without React**: `@kohaku-ui/renderer-wc`'s `<kohaku-surface>` — [User guide §2](../user-guide.md#demonstrating-the-non-react-renderer-web-components--zero-react).
