/**
 * Text fallback (the MCP Apps mandatory requirement MCPAPP-FBK-001).
 * The definition was moved to spec-core's specToText (#4: since the same summary is also used for
 * ui/update-model-context from the widget, it is shared with renderers that cannot import host-mcp-apps).
 * This is a backward-compatible re-export that does not break the existing import source (@kohaku-ui/host-mcp-apps).
 */
export { specToText } from "@kohaku-ui/spec-core";
