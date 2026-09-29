---
"@kohaku-ui/cli": patch
---

`kohaku init --mcp`: the generated Streamable HTTP server now builds its host once per process (so the Spec cache, fixations and lineage survive across calls), validates the Host and Origin headers (localhost by default, `KOHAKU_MCP_ALLOWED_HOSTS` / `KOHAKU_MCP_ALLOWED_ORIGINS` to extend), no longer answers `Access-Control-Allow-Origin: *`, caps the request body at 4 MiB and closes its handler with the server. The generated README and next-steps text point at `server/ports.ts` and the new `fallbackIntent` option, and `init --mcp` now leads with `npm run mcp:claude-desktop`.
