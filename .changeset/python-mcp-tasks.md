---
"@kohaku-ui/host-mcp-apps": patch
---

Python port (`kohaku-ui` on PyPI): `kohaku.host_mcp` now implements the MCP Tasks extension (`io.modelcontextprotocol/tasks`, 2026-07-28), mirroring `host-mcp-apps`. `AttachOptions.tasks_enabled` (default `False`) makes `kohaku_compose` and the intent tools task-capable for a request that declares the extension in its `_meta`: such a request gets a `CreateTaskResult` (`resultType: "task"`, `ttlMs` 600 000, `pollIntervalMs` 2 000) and polls `tasks/get` or cancels with `tasks/cancel` (which aborts the in-flight compose). With the default the server neither declares the extension nor registers `tasks/*`, and every tool stays synchronous. The TypeScript `@kohaku-ui/host-mcp-apps` is unchanged: it carries no code change in this entry and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.
