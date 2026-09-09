import { SANDBOX_HTML_TYPE } from "./schema/component.js";
import type { UISpec } from "./schema/spec.js";

/**
 * Text summary (Markdown) of a UI Spec.
 * A fallback rendering that still conveys meaning on hosts without UI support; in the MCP Apps
 * profile it is always carried in CallToolResult.content[0] (MCPAPP-FBK-001). The same summary is
 * also reused for a widget's `ui/update-model-context` (feeding the current view's model context
 * back after an interaction), so spec-core — not host-mcp-apps — is the definition site
 * (renderers cannot import host-mcp-apps due to the dependency direction and the single-file bundle
 * size constraint; the same precedent as moving HostErrorCode into spec-core). host-mcp-apps keeps a
 * backward-compatible re-export.
 */
export function specToText(spec: UISpec): string {
  const lines: string[] = [];
  for (const node of spec.components) {
    switch (node.type) {
      case "text.heading":
        lines.push(
          `${"#".repeat(Math.min(Number(node.props["level"] ?? 2), 4))} ${String(node.props["text"] ?? "")}`,
        );
        break;
      case "presentChart": {
        const kind = String(node.props["kind"] ?? "chart");
        const x = String(node.props["x"] ?? "");
        const y = Array.isArray(node.props["y"])
          ? (node.props["y"] as string[]).join(", ")
          : String(node.props["y"] ?? "");
        lines.push(`[Chart: ${kind}] ${y} by ${x} (data ref: \`${node.data?.$ref ?? "-"}\`)`);
        break;
      }
      case "presentSpreadsheet":
        lines.push(`[Table] data ref: \`${node.data?.$ref ?? "-"}\``);
        break;
      case "presentMarkdown":
        lines.push(String(node.props["markdown"] ?? ""));
        break;
      case "presentForm":
        lines.push(`[Input form] action: ${String(node.props["action"] ?? "-")}`);
        break;
      case SANDBOX_HTML_TYPE:
        lines.push(`[Generated widget (sandbox)] ${String(node.props["title"] ?? "")}`);
        break;
      default:
        if (node.type.startsWith("layout.")) break;
        lines.push(`[${node.type}]${node.data?.$ref != null ? ` data ref: \`${node.data.$ref}\`` : ""}`);
        break;
    }
  }
  lines.push("");
  lines.push(
    `*(intent: \`${spec.intent.canonical}\` / tier: ${spec.provenance.tier} / cache: ${spec.provenance.cache}. On UI-capable hosts the same Spec is rendered by the shared renderer.)*`,
  );
  // Keep the blank line (separator) as-is.
  return lines.join("\n");
}
