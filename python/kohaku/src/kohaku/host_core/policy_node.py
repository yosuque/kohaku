"""File-reading half of the Policy-as-Code runtime (port of packages/host-core/src/policy-node.ts).

Kept as its own module purely to preserve the "one TS file -> one Python module" layout rule
(python-mirror.md) -- unlike the TS port, this is re-exported from the package's top-level
`__init__.py` like everything else: Python has no bundler/browser-tree-shaking concern to protect
against by hiding it behind a separate import path (see policy.py's own module docstring for the full
rationale of why TS keeps it out of its main entry point via a package "subpath" export).
"""

from __future__ import annotations

import json
from pathlib import Path

from .policy import ParsedPolicy, parse_policy

__all__ = ["ParsedPolicy", "load_policy_file", "parse_policy"]


async def load_policy_file(path: str | Path) -> ParsedPolicy:
    """Reads, JSON-decodes, and validates (`parse_policy`) a policy file from disk. `async` to mirror
    the TS port's signature (Node's `fs/promises`) even though the read itself is a plain blocking
    `Path.read_text` call -- the same convention `kohaku.storage`'s file-backed `StoragePort` already
    uses for its own (also actually-synchronous) file I/O."""
    raw = Path(path).read_text(encoding="utf-8")
    return parse_policy(json.loads(raw))
