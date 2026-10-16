---
"@kohaku-ui/host-mcp-apps": patch
"@kohaku-ui/host": patch
"@kohaku-ui/mcp-renderer": patch
"@kohaku-ui/cli": patch
---

Raise the MCP TypeScript SDK floor to the 2.3 line: `@modelcontextprotocol/server` / `client` / `core` `^2.3.1` (were `^2.0.0`), `@modelcontextprotocol/node` `^2.1.1`, `@modelcontextprotocol/ext-apps` `^2.0.3`. The peer ranges of `@kohaku-ui/host-mcp-apps` (`server`), `@kohaku-ui/host` (`server`, `node`) and `@kohaku-ui/mcp-renderer` (`ext-apps`) follow, and `kohaku init --mcp` now generates projects that depend on `@modelcontextprotocol/server` `^2.3.1` and `@modelcontextprotocol/node` `^2.1.1`. No source change was needed for the types.

Observed behavior change of the Tasks extension (`io.modelcontextprotocol/tasks`) under SDK 2.3 (the published 0.4.0 declares `^2.0.0`, so its users already resolve SDK 2.3.x):

- SDK 2.0.0 rejected `tasks/get` / `tasks/cancel` with `-32601` before kohaku's handlers ran. Since SDK 2.3.0 (SEP-2663) the SDK lets those two names through when a schema-explicit handler is registered, which kohaku does, so they are now reachable. The SDK also requires `Mcp-Name: <taskId>` on them (SDK clients send it); a request without it is rejected with `-32020` before dispatch.
- `AttachOptions.tasksEnabled` unset (the default, unchanged): no behavior change. The extension is neither declared nor registered, `tasks/get` / `tasks/cancel` still answer `-32601`, and the compose family stays synchronous.
- `AttachOptions.tasksEnabled: true`: `tasks/get` and `tasks/cancel` went from unreachable to working. A task-backed `kohaku_compose` can now be polled to `completed` and cancelled over the wire.

The `host-mcp-apps` tripwire tests were updated accordingly, and cancellation is now tested through a real `tasks/cancel`. The default of `tasksEnabled` is a separate product decision and is left unchanged.
