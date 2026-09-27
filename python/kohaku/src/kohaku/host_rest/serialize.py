"""JSON-ification helper for response bodies.

Re-exports kohaku.host_core.serialize.to_jsonable, where it now lives (kohaku.host_mcp needed the identical
conversion once design.md #64's Action manifest started riding in an MCP tool result's `_meta`, and host_rest /
host_mcp are independent sibling layers that must not import each other). This module is kept as a thin
re-export so existing `from kohaku.host_rest.serialize import to_jsonable` imports (in this package and in
tests) keep working.
"""

from __future__ import annotations

from kohaku.host_core.serialize import to_jsonable

__all__ = ["to_jsonable"]
