# @kohaku-ui-sample/mcp — MCP server demo (MCP Apps profile)

English | [日本語](README.ja.md)

Delivers the same UI Spec and the same shared renderer as the Web to MCP Apps-capable chat hosts
(Claude Desktop / claude.ai / ChatGPT). The operational details (rendering paths per host, tools,
snapshot fallback, tunnels) are covered in the [user guide §5](../../docs/user-guide.md#5-using-it-from-an-external-chat-mcp)
— this README is the minimal map for someone landing in this folder.

## Prerequisite (one-time)

```bash
pnpm --filter @kohaku-ui-sample/mcp build:renderer   # single-file build of the shared renderer
```

## Entry points

```bash
pnpm --filter @kohaku-ui-sample/mcp start        # stdio (Claude Desktop / local hosts)
pnpm --filter @kohaku-ui-sample/mcp start:http   # Streamable HTTP on :8788 (claude.ai / ChatGPT via a public tunnel)
```

⚠️ The HTTP entry is an **unauthenticated demo** — see the user guide for tunnel cautions and env vars
(`KOHAKU_MCP_HTTP_PORT` / `KOHAKU_MCP_PUBLIC_URL` / `KOHAKU_MCP_HTTP_ALLOWED_HOSTS`, etc.).

## What to know first

- **Three rendering paths depending on the host**: MCP Apps iframe (same rendering as the Web) /
  `kohaku_render_snapshot` self-contained HTML (terminal hosts) / model-drawn fallback text.
- **Persistence is shared with sample-api** (`../sample-api/.data`); each process loads it at startup,
  so cross-process changes (promotions, lineage) are picked up on restart.
- Layout: `src/index.ts` (stdio) / `src/http.ts` (Streamable HTTP) / `src/setup.ts` (shared wiring) /
  `renderer/` (the shared-renderer build for the iframe).
