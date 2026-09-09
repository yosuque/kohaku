"""L2 verification JS sidecar (Task #39).

Because Python has no JS runtime, the two checks of L2-generated HTML —
- L2_SCRIPT_SYNTAX (<script> JS syntax check; TS implements it inline via new Function)
- smoke verification (run under jsdom and confirm ready() is reached; TS uses @kohaku-ui/sandbox/smoke)
— are not reimplemented here but delegated in a subprocess to the repository-bundled TS CLI (`kohaku smoke-l2`).
The verification logic reuses the TS side (collectScriptSyntaxIssues / createL2Smoke) as the **single source
of truth** (no dual implementation).

**Only in an environment where Node is co-located** does this resolve the known differences (the
L2_SCRIPT_SYNTAX skip in l2_lint.py / the smoke runner not being bundled). Standalone (Node not co-located /
CLI absent), the checks are simply skipped as before and compose does not break (fail-open). The intended
usage is to wire this into ComposePolicy only when `is_available()` is true.

Calls are one process per request (not kept resident — simplicity first; delegation happens only at L2
generation time and is infrequent). All three fail-open stages (node absent / CLI absent / execution failure or
timeout) return [] (check skipped), and only on the first occurrence write a one-line notice to stderr.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any

from .context import L2SmokeContext

# The TS CLI launcher directly under the repository root (runs src/index.ts via tsx).
_CLI_RELATIVE = ("cli", "bin", "kohaku.js")


def _find_cli_path() -> Path | None:
    """Finds the CLI launcher (cli/bin/kohaku.js) that starts `kohaku smoke-l2`.

    Priority: explicit override via env KOHAKU_L2_JS_CLI → upward search from __file__ and cwd. The upward
    search takes the ancestor that has both `cli/bin/kohaku.js` and `node_modules` (dependencies installed = Node co-located).
    """
    override = os.environ.get("KOHAKU_L2_JS_CLI")
    if override:
        p = Path(override)
        return p if p.is_file() else None
    # Search from both __file__ (inside the ported tree) and cwd (python/ under uv). Either path can reach the monorepo root.
    seen: set[Path] = set()
    for start in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        for d in (start, *start.parents):
            if d in seen:
                continue
            seen.add(d)
            cli = d.joinpath(*_CLI_RELATIVE)
            if cli.is_file() and (d / "node_modules").is_dir():
                return cli
    return None


class L2JsSidecar:
    """A thin sidecar client to `kohaku smoke-l2`.

    lint / smoke are callables that can be passed directly to ComposePolicy.l2ScriptSyntax / l2Smoke
    (`(html) -> Awaitable[list[str]]` / `(html, ctx) -> Awaitable[list[str]]`).
    """

    def __init__(
        self,
        node_command: list[str],
        cli_path: Path | None,
        *,
        timeout_s: float,
        ready_timeout_ms: int,
    ) -> None:
        self.node_command = node_command
        self.cli_path = cli_path
        self.timeout_s = timeout_s
        self.ready_timeout_ms = ready_timeout_ms
        self._warned = False

    def is_available(self) -> bool:
        """Whether both the node executable and the CLI launcher can be resolved (decided without spawning).

        Wire into ComposePolicy only when true (when false, wiring it still always returns [] = check skipped).
        """
        if self.cli_path is None:
            return False
        exe = self.node_command[0] if self.node_command else ""
        return exe != "" and shutil.which(exe) is not None

    async def lint(self, html: str) -> list[str]:
        """Delegates the <script> syntax check (L2_SCRIPT_SYNTAX) to the CLI."""
        return await self._run({"mode": "lint", "html": html})

    async def smoke(self, html: str, ctx: L2SmokeContext) -> list[str]:
        """Delegates jsdom smoke verification (L2_SMOKE_*) to the CLI. Synthetic data is built deterministically from shape."""
        payload: dict[str, Any] = {
            "mode": "smoke",
            "html": html,
            "readyTimeoutMs": self.ready_timeout_ms,
        }
        if ctx.shape is not None:
            payload["shape"] = ctx.shape.model_dump(by_alias=True, exclude_none=True)
        return await self._run(payload)

    async def _run(self, payload: dict[str, Any]) -> list[str]:
        if self.cli_path is None:
            self._warn("CLI (cli/bin/kohaku.js) not found")
            return []
        cmd = [*self.node_command, str(self.cli_path), "smoke-l2"]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, OSError) as e:
            # node absent (executable missing), etc.
            self._warn(f"failed to start Node ({e})")
            return []
        stdin_bytes = json.dumps(payload).encode("utf-8")
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(stdin_bytes), timeout=self.timeout_s
            )
        except TimeoutError:
            proc.kill()
            with suppress(ProcessLookupError):
                await proc.wait()
            self._warn("verification timed out")
            return []
        except Exception as e:  # noqa: BLE001 — unexpected failures in the communication stage are also fail-open
            self._warn(f"failed to run verification ({e})")
            return []
        if proc.returncode != 0:
            detail = stderr.decode("utf-8", "replace").strip()
            self._warn(f"verification exited abnormally (exit={proc.returncode}: {detail})")
            return []
        try:
            parsed = json.loads(stdout.decode("utf-8"))
            issues = parsed["issues"]
            if not isinstance(issues, list) or not all(isinstance(x, str) for x in issues):
                raise ValueError("issues is not an array of strings")
            return issues
        except (json.JSONDecodeError, KeyError, ValueError, UnicodeDecodeError) as e:
            self._warn(f"failed to interpret the verification result ({e})")
            return []

    def _warn(self, reason: str) -> None:
        """Write a one-line notice to stderr only on the first skip (to prevent the check being silently disabled by accident)."""
        if self._warned:
            return
        self._warned = True
        sys.stderr.write(
            f"[l2-js-sidecar] skipping JS verification ({reason} / fail-open). "
            "L2_SCRIPT_SYNTAX / smoke verification will not be performed\n"
        )


def create_l2_js_sidecar(
    node_command: list[str] | None = None,
    *,
    timeout_s: float = 10.0,
    ready_timeout_ms: int = 1000,
) -> L2JsSidecar:
    """Creates the L2 verification JS sidecar.

    node_command: the command to start Node (default ["node"]). Passing a nonexistent command in tests lets you
        verify fail-open (is_available()=False; lint/smoke return []).
    timeout_s: the wall-clock cap per process (including node/tsx startup + verification).
    ready_timeout_ms: the cap for waiting for ready to be reached during smoke (ms; passed to the CLI-side jsdom). Can be shortened in tests.
    """
    return L2JsSidecar(
        node_command=list(node_command) if node_command is not None else ["node"],
        cli_path=_find_cli_path(),
        timeout_s=timeout_s,
        ready_timeout_ms=ready_timeout_ms,
    )
