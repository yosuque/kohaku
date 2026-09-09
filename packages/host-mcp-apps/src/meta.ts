/**
 * The canonical constants for MCP Apps (SEP-1865).
 * Kept in sync with @modelcontextprotocol/ext-apps' public constants
 * (ext-apps is a browser-side SDK, so the server side holds the values directly).
 */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The modern (nested) form of the _meta key. Since SEP-1865 was formalized (2026-01-26), this
 * `ui: { resourceUri, visibility }` (McpUiToolMeta) is canonical, and ChatGPT etc. look at it first.
 */
export const UI_META_KEY = "ui";
/** The legacy (flat) form of the _meta key. Emitted alongside for backward compatibility with hosts that only read modern. */
export const RESOURCE_URI_META_KEY = "ui/resourceUri";
export const VISIBILITY_META_KEY = "ui/visibility";

export const RENDERER_RESOURCE_URI = "ui://kohaku/renderer.html";

/**
 * The key for co-embedding the initial data (server-side preresolved `{ [effective ref]: TabularData }`) in a tool
 * result's `_meta`. Since `_meta` does not enter the model's context and is transferred only to the widget,
 * the initial display can be made complete while upholding the "bulk data never passes through the model" principle.
 * The renderer (apps/sample-mcp/renderer/main.tsx) reads this key's literal string directly
 * (it does not import host-mcp-apps, to respect the dependency direction and avoid single-file bundle bloat; the match is guaranteed by a test).
 */
export const INITIAL_DATA_META_KEY = "kohaku/initialData";

/**
 * The key for co-embedding the compose-issued capability token in a tool result's `_meta`, alongside
 * `INITIAL_DATA_META_KEY`. Previously the capability rode `structuredContent.capability`, which is
 * model-visible: a host that ignores `kohaku_action`'s app-only visibility hint (or a prompt-injected
 * instruction) could then have the model itself read the token and drive `${prefix}_action` with an
 * arbitrary payload. `_meta` does not enter the model's context and is transferred only to the widget, so
 * moving the token here closes that path the same way `INITIAL_DATA_META_KEY` already does for bulk data.
 * The renderer (apps/sample-mcp/renderer/host-integration.ts) reads this key's literal string directly
 * (it does not import host-mcp-apps, to respect the dependency direction and avoid single-file bundle bloat; the match is guaranteed by a test).
 */
export const CAPABILITY_META_KEY = "kohaku/capability";

export type ToolVisibility = "model" | "app";

/**
 * The shape of the tool-side `_meta.ui` (modern). A local declaration kept in sync with ext-apps' `McpUiToolMeta`
 * (since the server side does not take ext-apps as a runtime dependency, the type agreement is pinned at compile time by
 * test/ext-apps-interop.test.ts). Placing csp / permissions on the tool side is forbidden by SEP-1865
 * (those are the province of the resource-side `_meta.ui`).
 */
export interface McpToolUiMeta {
  resourceUri?: string;
  visibility?: ToolVisibility[];
}

/**
 * The shape of the resource-side `_meta.ui` (a local declaration corresponding to ext-apps' `McpUiResourceMeta`).
 * Each array in csp is "the allowlist of external origins the UI may connect to / load from".
 */
export interface McpResourceUiMeta {
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
  domain?: string;
  prefersBorder?: boolean;
}

/**
 * The `_meta` of the shared renderer resource (SEP-1865 resource-side UI metadata).
 * Since the shared renderer is a single-file bundle and even data fetching goes through the bridge (app-only tools),
 * it **needs no external origin at all = explicitly declares every csp allowlist as an empty array**.
 * By declaring empty arrays rather than omitting them (deferring to the host default), it tells the host that it may apply
 * the strictest sandbox. permissions (camera, etc.) are not needed, so they are not declared (undeclared = not requested).
 * Placed on both resources/list (registerResource's metadata) and the resources/read contents
 * (SEP-1865 stipulates the contents side takes precedence — if both are the same value, there is no difference).
 */
export function resourceUiMeta(): { ui: McpResourceUiMeta } {
  return {
    ui: {
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
    },
  };
}

/**
 * Assembles a tool's _meta (the UI declaration).
 *
 * With the formalization of SEP-1865 (2026-01-26), the nested form `_meta.ui.{resourceUri,visibility}` (modern) became
 * canonical for the UI declaration, and some hosts such as ChatGPT only read modern. Meanwhile, older hosts read the flat
 * `_meta["ui/resourceUri"]` / `_meta["ui/visibility"]` (legacy). To be recognized as a UI tool by either host,
 * **emit both modern and legacy** (with identical values).
 */
export function toolUiMeta(opts: {
  resourceUri?: string;
  visibility?: ToolVisibility[];
}): Record<string, unknown> {
  // modern (nested): put only the specified fields under ui.
  const ui: McpToolUiMeta = {
    ...(opts.resourceUri != null ? { resourceUri: opts.resourceUri } : {}),
    ...(opts.visibility != null ? { visibility: opts.visibility } : {}),
  };
  return {
    // modern (nested): canonical since the formalization of SEP-1865
    ...(Object.keys(ui).length > 0 ? { [UI_META_KEY]: ui } : {}),
    // legacy (flat): backward compatibility
    ...(opts.resourceUri != null ? { [RESOURCE_URI_META_KEY]: opts.resourceUri } : {}),
    ...(opts.visibility != null ? { [VISIBILITY_META_KEY]: opts.visibility } : {}),
  };
}
