"""Intent catalog (port of packages/semantic-llm/src/catalog.ts).

`IntentCatalogLike` is the read side of an Intent catalog that NL / GUI normalization and `resolve_query` need.
`IntentCatalog` is the mutable implementation: the core definitions plus whatever promotion adds (`add`) or
withdraws (`remove`), with a `revision` counter that moves on every actual mutation.

Naming: TS's `list()` is `list_defs()` here, to avoid shadowing the builtin `list` (the codebase's
`list_operations` / `list_events` naming).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from kohaku.intents import IntentDef
from kohaku.spec import IntentValidationIssue, JsonObject


@dataclass(frozen=True)
class ParamsValidation:
    """Result of `validate_params`: either the normalized params (defaults filled in) or a list of
    client-safe issues (port of the TS discriminated union `{ ok: true; params } | { ok: false; issues }`)."""

    ok: bool
    params: JsonObject | None = None
    issues: list[IntentValidationIssue] = field(default_factory=list)


class IntentCatalogLike(Protocol):
    """The read side of an Intent catalog: what NL / GUI normalization and resolve_query need.

    Two members of TS's `IntentCatalogLike` are optional there (`revision?`, `validateParams?`). A Python
    `Protocol` cannot express an optional member, so they are probed at the call site instead, with
    `getattr(catalog, "revision", None)` and `getattr(catalog, "validate_params", None)`:

    - `revision: int` -- a counter that changes whenever the set of Intents changes (add / remove). Consumers
      that cache derived data per catalog object (`render_catalog_doc`'s prompt-doc cache) key on it in
      addition to object identity, so a mutation is never served stale. An immutable catalog may omit it; a
      mutable catalog that omits it cannot be cached safely across a mutation.
    - `validate_params(name, params) -> ParamsValidation` -- strict validation for a directly-specified Intent
      (backs `LlmSemanticPort.validate_intent`). Unlike `normalize_params`, a failure carries structured,
      client-safe issues instead of collapsing to `None`, and an unknown param key is itself an issue rather
      than being silently stripped. A catalog that omits it falls back to the looser `normalize_params` check.
    """

    def get(self, name: str) -> IntentDef | None: ...

    def list_defs(self) -> list[IntentDef]: ...

    def names(self) -> list[str]: ...

    def normalize_params(self, name: str, params: JsonObject) -> JsonObject | None:
        """Validates params and returns the normalized form with defaults filled in. None on failure."""
        ...


class IntentCatalog:
    """A mutable Intent catalog: the core definitions plus whatever promotion adds (add) or withdraws (remove)."""

    def __init__(self, defs: list[IntentDef]) -> None:
        self._defs: dict[str, IntentDef] = {d.name: d for d in defs}
        self._revision = 0

    def get(self, name: str) -> IntentDef | None:
        return self._defs.get(name)

    def list_defs(self) -> list[IntentDef]:
        return list(self._defs.values())

    def names(self) -> list[str]:
        return list(self._defs.keys())

    @property
    def revision(self) -> int:
        """Changes whenever `add` / `remove` actually change the set of Intents (see IntentCatalogLike)."""
        return self._revision

    def add(self, def_: IntentDef) -> None:
        """Adds (or replaces) an Intent, e.g. a dynamic Intent via promotion."""
        self._defs[def_.name] = def_
        self._revision += 1

    def remove(self, name: str) -> None:
        """Removes an Intent (e.g. promotion withdrawal). Removing an unknown name is a no-op (no revision bump)."""
        if self._defs.pop(name, None) is not None:
            self._revision += 1

    def normalize_params(self, name: str, params: JsonObject) -> JsonObject | None:
        """Validates params and returns the normalized form with defaults filled in. None on failure."""
        def_ = self._defs.get(name)
        if def_ is None:
            return None
        result = def_.params.safe_parse(params)
        return result.data if result.success else None

    def validate_params(self, name: str, params: JsonObject) -> ParamsValidation:
        """Strict validation for a directly-specified Intent (backs LlmSemanticPort.validate_intent).

        Unlike normalize_params, an unknown param key is itself reported as an issue instead of being silently
        stripped (ObjectSchema.parse's default "strip unrecognized keys" behavior, mirroring zod's own
        non-strict object parsing), and a failure carries structured, client-safe issues -- naming which param
        failed -- instead of collapsing to None. Uses ObjectSchema.validate (not safe_parse) so every field's
        issue is collected, not just the first.
        """
        def_ = self._defs.get(name)
        if def_ is None:
            return ParamsValidation(
                ok=False,
                issues=[IntentValidationIssue(path="", message=f'unknown intent "{name}"')],
            )
        shape = def_.params.shape
        issues = [
            IntentValidationIssue(path=key, message=f'unknown param "{key}"')
            for key in params
            if key not in shape
        ]
        result = def_.params.validate(params)
        if not issues and result.success:
            assert result.data is not None
            return ParamsValidation(ok=True, params=result.data)
        for issue in result.issues:
            issues.append(
                IntentValidationIssue(
                    path=issue.path, message=f'param "{issue.path}": {issue.message}'
                )
            )
        return ParamsValidation(ok=False, issues=issues)


def create_intent_catalog(defs: list[IntentDef]) -> IntentCatalog:
    return IntentCatalog(defs)
