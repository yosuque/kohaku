"""Text summary (Markdown) of a UI Spec (port of TS spec-text.ts).

A fallback rendering that still conveys meaning on hosts without UI support; in the MCP Apps
profile it is always carried in CallToolResult.content[0] (MCPAPP-FBK-001). The same summary is
also reused for a widget's `ui/update-model-context` (feeding the current view's model context back
after an interaction), so the spec layer — not host_mcp — is the definition site (renderers cannot
import host_mcp due to the dependency direction; the same precedent as moving HostErrorCode into the
spec layer). host_mcp keeps a backward-compatible re-export.
"""

from __future__ import annotations

from .canonical_json import js_string
from .models import SANDBOX_HTML_TYPE, JsonValue, UISpec


def _prop_or(props: dict[str, JsonValue], key: str, default: str) -> str:
    """Stringify props[key] by the same rule as JS `String(props[key] ?? default)`."""
    value = props.get(key)
    return default if value is None else js_string(value)


def spec_to_text(spec: UISpec) -> str:
    """Return a non-empty text summary (Markdown) of a UI Spec. The MCP Apps text-fallback convention."""
    lines: list[str] = []
    for node in spec.components:
        props = node.props
        ref = node.data.ref if node.data is not None else None
        if node.type == "text.heading":
            level = props.get("level")
            level_num = int(level) if isinstance(level, (int, float)) else 2
            lines.append(f"{'#' * min(level_num, 4)} {_prop_or(props, 'text', '')}")
        elif node.type == "presentChart":
            kind = _prop_or(props, "kind", "chart")
            x = _prop_or(props, "x", "")
            y_raw = props.get("y")
            if isinstance(y_raw, list):
                y = ", ".join(js_string(v) for v in y_raw)
            else:
                y = _prop_or(props, "y", "")
            lines.append(f"[Chart: {kind}] {y} by {x} (data ref: `{ref if ref is not None else '-'}`)")
        elif node.type == "presentSpreadsheet":
            lines.append(f"[Table] data ref: `{ref if ref is not None else '-'}`")
        elif node.type == "presentMarkdown":
            lines.append(_prop_or(props, "markdown", ""))
        elif node.type == "presentForm":
            lines.append(f"[Input form] action: {_prop_or(props, 'action', '-')}")
        elif node.type == SANDBOX_HTML_TYPE:
            lines.append(f"[Generated widget (sandbox)] {_prop_or(props, 'title', '')}")
        else:
            if node.type.startswith("layout."):
                continue
            suffix = f" data ref: `{ref}`" if ref is not None else ""
            lines.append(f"[{node.type}]{suffix}")
    lines.append("")
    lines.append(
        f"*(intent: `{spec.intent.canonical}` / tier: {spec.provenance.tier} / "
        f"cache: {spec.provenance.cache}. On UI-capable hosts the same Spec is rendered by the shared renderer.)*"
    )
    return "\n".join(lines)
