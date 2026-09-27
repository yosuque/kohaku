---
"@kohaku-ui/mcp-renderer": minor
"@kohaku-ui/cli": minor
---

Add `@kohaku-ui/mcp-renderer`, a new package: the shared renderer that runs inside an MCP Apps iframe,
distributed for reuse outside this repository (it used to live only inside `apps/sample-mcp`).

- `.` — `loadRendererHtml(): Promise<string>` reads this package's own pre-built, single-file
  `dist/renderer.html` (the core kohaku component set, no product-specific implementations). **Zero npm
  dependencies** — a consumer that only wants the stock renderer installs nothing beyond this package.
- `./boot` — `bootMcpRenderer({ registerImpls?, root? })` is the source the core build itself is built from,
  and what a product rebuilds with its own component implementations baked in (mirroring the Web app's
  registry overlay). Its `@kohaku-ui/renderer-react` / `renderer-core` / `data-binding` / `spec-core` /
  `@modelcontextprotocol/ext-apps` / `react` / `react-dom` dependencies are all optional peer dependencies —
  `.` never imports `./boot`, so they are never installed by a plain `npm install @kohaku-ui/mcp-renderer`.

`apps/sample-mcp`'s own renderer (sales-domain implementations baked in) is now a thin rebuild against
`./boot` instead of the renderer's original home.

`kohaku init --mcp` generates an MCP front door on top of the always-generated REST one:
`server/mcp-server.ts` (`attachMcpServer`, wiring the same host `server/ports.ts` builds onto
`@kohaku-ui/host/mcp`'s `attachKohakuMcp`, with `@kohaku-ui/mcp-renderer`'s `loadRendererHtml` and typed
MCP tools from the generated Intent catalog), `server/mcp.ts` (stdio, `npm run mcp`) and
`server/mcp-http.ts` (Streamable HTTP on :8788, `npm run mcp:http`), plus a
`claude_desktop_config.example.json` and `scripts/claude-desktop.mjs` (`npm run mcp:claude-desktop`
registers the project with Claude Desktop, backing up its existing config to `.bak` first; `-- --print`
previews the merge without writing anything — the real config is only ever touched by a person running
this script themselves).

`kohaku init`'s generated `server/app.ts` is split into `server/ports.ts` (`createPorts`, the
`createKohakuHost()` call) + `server/app.ts` (the REST-specific facet-views / health routes on top of it),
so the new MCP front door builds the same host without importing Hono routes it does not need.

See `docs/design.md` decision #56 for the full rationale.

**Before its first release, a maintainer must bootstrap the new package** (`node scripts/npm-bootstrap.mjs
--publish`, run from a maintainer's own terminal) — see `docs/runbooks/release.md`, "First publish of a new
package": npm can only register a trusted publisher for a package that already exists on the registry, so
`@kohaku-ui/mcp-renderer`'s own first publish cannot go through `release.yml`'s OIDC flow the way every
other already-published package's release does.
