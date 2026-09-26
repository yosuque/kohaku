import { type AttachOptions, attachKohakuToMcpServer } from "@kohaku-ui/host-mcp-apps";
import type { McpServer } from "@modelcontextprotocol/server";
import type { KohakuHost } from "./create-host.js";

export type { AttachOptions } from "@kohaku-ui/host-mcp-apps";

/**
 * Attaches the host `createKohakuHost()` built to an MCP server, via `@kohaku-ui/host-mcp-apps`'s
 * `attachKohakuToMcpServer`: `compose` / `domain` / `authz` / `querySource` come straight from `host`, so
 * the REST and MCP profiles compose against the exact same Ports. `options` is passed through unchanged
 * (`rendererHtml` is the only required field -- see `AttachOptions`).
 *
 * Kept out of `@kohaku-ui/host`'s main entry point (`.`) so a REST-only consumer never has to install
 * `@modelcontextprotocol/server` (an optional peer dependency of this package, needed only for this subpath).
 */
export function attachKohakuMcp(server: McpServer, host: KohakuHost, options: AttachOptions): void {
  attachKohakuToMcpServer(
    server,
    {
      compose: host.compose,
      domain: host.ports.domain,
      authz: host.ports.authz,
      querySource: host.querySource,
    },
    options,
  );
}
