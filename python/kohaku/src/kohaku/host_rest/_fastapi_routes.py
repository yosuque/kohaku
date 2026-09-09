"""Facade over the FastAPI-dependent REST route implementation (the route bodies of routes.ts).

The route bodies used to live directly in this module; they now live under `_routes/` split by group
(shared / compose / binding / governance / promotions / fixations, mirroring
packages/host-rest/src/routes/*.ts — see `_routes/__init__.py` for the registration-order contract). This
module is kept as a thin **facade**: it still exposes `register_routes` and every name tests or other
internal modules import from `_fastapi_routes` (grep `python/kohaku/tests` for `_fastapi_routes` and
`host_mcp/server.py`'s comments referencing it to see the full surface), so nothing outside this package
needs to know about the split.

`_locks` is re-exported as the *same dict object* used by `_routes.shared._get_lock` (a plain `from ... import
_locks`, not a copy) — tests mutate it through `_get_lock` and assert on it via `fr._locks`.

This module still performs a **real top-level import** of fastapi / starlette (transitively, via `_routes`) —
because FastAPI resolves the `request: Request` / `-> Response` annotations from each route module's globals
via `get_type_hints`, the annotations must be resolvable at runtime (a TYPE_CHECKING deferred import would
yield a 422).

Lazy loading and guidance when fastapi is not installed are handled by `routes.attach_kohaku_routes` (the routes
can only be assembled when this module can be imported). See the routes.py header docstring for design decisions
and intentional differences.
"""

from __future__ import annotations

from ._routes import register_routes as register_routes
from ._routes.compose import _compose_stream_body as _compose_stream_body
from ._routes.compose import _disconnect_abort as _disconnect_abort
from ._routes.compose import _with_heartbeat as _with_heartbeat
from ._routes.compose import compose_with_fixation as compose_with_fixation
from ._routes.compose import issue_capability_for_spec as issue_capability_for_spec
from ._routes.compose import settle_fixation as settle_fixation
from ._routes.shared import _get_lock as _get_lock
from ._routes.shared import _locks as _locks
from ._routes.shared import to_session as to_session
