# @kohaku-ui/mcp-renderer

The shared renderer that runs inside an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) iframe,
packaged for reuse outside this repository.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

## `.` — the pre-built bundle (zero dependencies)

```bash
npm install @kohaku-ui/mcp-renderer
```

```ts
import { loadRendererHtml } from "@kohaku-ui/mcp-renderer";
import { attachKohakuMcp } from "@kohaku-ui/host/mcp";

attachKohakuMcp(server, host, { rendererHtml: loadRendererHtml });
```

`loadRendererHtml()` reads the package's own pre-built, single-file `dist/renderer.html` (core kohaku
component set, no product-specific implementations) and memoizes it. This entry point has **no npm
dependencies at all** — a consumer that only needs the stock renderer never installs React, renderer-react,
or anything else. `kohaku init --mcp` wires a generated project this way.

## `./boot` — build your own renderer bundle

Once your product has its own component implementations (the same `registerImpls` function your Web app's
renderer registry uses), rebuild the renderer with them baked in instead of the core-only default:

```bash
npm install @kohaku-ui/mcp-renderer @kohaku-ui/renderer-react @kohaku-ui/renderer-core @kohaku-ui/data-binding @kohaku-ui/spec-core @modelcontextprotocol/ext-apps react react-dom
```

```tsx
// renderer/main.tsx -- your own Vite entry point (see apps/sample-mcp/renderer/main.tsx for a worked
// example, including the vite-plugin-singlefile config that builds it into one self-contained HTML file)
import { bootMcpRenderer } from "@kohaku-ui/mcp-renderer/boot";
import { registerMyImpls } from "./renderer-impls.js";

await bootMcpRenderer({ registerImpls: registerMyImpls });
```

`bootMcpRenderer` handles both modes the shared renderer runs in: the normal ext-apps bridge (spec + data
delivered via MCP tool calls) and the static, self-contained snapshot mode `${prefix}_render_snapshot`
generates for UI-incapable hosts. `registerImpls` and `root` (which element/id to mount into, default
`"root"`) are the only options; everything else (theming, displayMode, self-recovery from a host that drops
its own tool-result notification) is handled internally, matching this package's own core-only build (see
`renderer/main.tsx` in this package's source, and its `vite.renderer.config.ts`).

Every `./boot` dependency (`@kohaku-ui/renderer-react`, `@kohaku-ui/renderer-core`,
`@kohaku-ui/data-binding`, `@kohaku-ui/spec-core`, `@modelcontextprotocol/ext-apps`, `react`, `react-dom`) is
an **optional peer dependency** of this package — none of them is pulled in by a plain
`npm install @kohaku-ui/mcp-renderer` (the `.` entry point above).

- Documentation: [docs/paths/mcp-apps.md](https://github.com/yosuque/kohaku/blob/main/docs/paths/mcp-apps.md)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/mcp-renderer

Licensed under the Apache License, Version 2.0.
