"""Text fallback (MCP Apps mandatory requirement MCPAPP-FBK-001).

The definition was relocated to the spec layer's spec_to_text (#4: the same summary is also used by the widget's
ui/update-model-context, so it is shared with the renderer, which cannot import host_mcp; same shape as spec-text.ts).
This is a backward-compatible re-export that does not break the existing import site (kohaku.host_mcp.fallback).
"""

from __future__ import annotations

from kohaku.spec import spec_to_text

__all__ = ["spec_to_text"]
