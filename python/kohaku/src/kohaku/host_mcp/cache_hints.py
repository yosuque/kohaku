"""MCP 2026-07-28 (SEP-2549) response-caching hints for this profile's cacheable results.

Split out of server.py (mechanical file-layout split, Task 6) — mirrors packages/host-mcp-apps/src/cache-hints.ts
in spirit, though Python's mcp SDK has no per-server `cacheHints` constructor option to wire these into the way
TS's `defaultMcpListCacheHints()` does (see this module's callers in server.py's `_list_tools` / `_list_resources`
/ `_read_resource`, which stamp these values directly onto each result instead).
"""

from __future__ import annotations

from typing import Literal

# MCP 2026-07-28 (SEP-2549): freshness/cacheability hint attached to tools/list, resources/list, and (mcp
# 2.x closed a 1.x gap here — see _read_resource's doc comment) resources/read results
# (CacheableResult.ttl_ms / cache_scope). Matches TS host-mcp-apps' equivalent values.
_CACHEABLE_RESULT_TTL_MS = 60_000
_CACHEABLE_RESULT_CACHE_SCOPE: Literal["public", "private"] = "private"
