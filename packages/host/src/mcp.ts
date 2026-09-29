import { createConsoleErrorReporter } from "@kohaku-ui/host-core";
import { type AttachOptions, attachKohakuToMcpServer, type McpHostDeps } from "@kohaku-ui/host-mcp-apps";
import type { McpServer } from "@modelcontextprotocol/server";
import type { KohakuHost } from "./create-host.js";

export type { AttachOptions } from "@kohaku-ui/host-mcp-apps";

/** `attachKohakuMcp`'s options: `AttachOptions` plus `deps`, the MCP profile's counterpart of `createKohakuHost`'s `routes`. */
export interface AttachKohakuMcpOptions extends AttachOptions {
  /**
   * Every other `McpHostDeps` field, passed through to `attachKohakuToMcpServer`: `resolvePrincipal`,
   * `approvals`, `rateLimiter`, `fixations`, ... The fields the host owns (`compose`, `domain`, `authz`,
   * `querySource`) cannot be overridden. `onError`, `recorder` and `actionAuditRecorder` are set here by
   * default (the console error reporter, and the host's View Lineage and action-audit recorders) and are
   * replaced by what you pass.
   */
  deps?: Partial<Omit<McpHostDeps, "compose" | "domain" | "authz" | "querySource">>;
}

/**
 * Attaches the host `createKohakuHost()` built to an MCP server, via `@kohaku-ui/host-mcp-apps`'s
 * `attachKohakuToMcpServer`: `compose` / `domain` / `authz` / `querySource` come straight from `host`, so
 * the REST and MCP profiles compose against the exact same Ports. `options` is passed through (`rendererHtml`
 * is the only required field -- see `AttachOptions`), except for `deps`, which is merged into the MCP host deps.
 *
 * Like the REST half, the MCP profile gets the console error reporter as its `onError` and the host's View
 * Lineage `recorder` and `actionAuditRecorder` by default, so a failed tool call is visible on stderr and MCP views land in the same
 * lineage `kohaku explain` reads.
 *
 * Kept out of `@kohaku-ui/host`'s main entry point (`.`) so a REST-only consumer never has to install
 * `@modelcontextprotocol/server` (an optional peer dependency of this package, needed only for this subpath).
 */
export function attachKohakuMcp(server: McpServer, host: KohakuHost, options: AttachKohakuMcpOptions): void {
  const { deps, ...attachOptions } = options;
  attachKohakuToMcpServer(
    server,
    {
      onError: createConsoleErrorReporter({ debug: host.debug }).mcp,
      ...(host.recorder != null ? { recorder: host.recorder } : {}),
      ...(host.actionAuditRecorder != null ? { actionAuditRecorder: host.actionAuditRecorder } : {}),
      ...deps,
      compose: host.compose,
      domain: host.ports.domain,
      authz: host.ports.authz,
      querySource: host.querySource,
    },
    attachOptions,
  );
}
