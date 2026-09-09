"""A record/replay LlmPort (port of TS packages/evals/src/fixture-llm.ts).

The key is the first 24 hex digits of sha256(prompt + system + schemaName).
- replay (default): responds deterministically from fixtures (CI runs on this)
- record: delegates to the inner real LlmPort and writes the response back to a fixture
  (pass `record=True, live=<LlmPort>` to the constructor; remove record when replaying).
  In Python, placing a FakeLlm inside lets record run even without a real LLM.

The fixture file format is compatible with the TS implementation (so the same fixture works in both languages).
object is `{"object": <value>, "prompt": <first 400 chars>}`, text is `{"text": <value>, "prompt": ...}`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel

from kohaku.llm import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextRequest,
    GenerateTextResult,
    LlmError,
    LlmPort,
    LlmUsage,
    SchemaValidationError,
    is_validating_schema,
    validate_against_schema,
)
from kohaku.spec import sha256_hex

_USAGE: Final = LlmUsage(input_tokens=0, output_tokens=0)
_MISSING: Final = object()
"""A sentinel to distinguish "fixture not recorded" from "the recorded value is None"."""

_KEY_SEP: Final = chr(0)
"""The key-generation join separator (NUL / U+0000). Matches the TS implementation's join("\\u0000")."""


def _to_json_value(obj: object) -> Any:
    """Reduce a response to a JSON value at record time.

    Even if the inner live (e.g. FakeLlm) returns a validated model (a pydantic instance), the fixture is
    written out as language-neutral raw JSON (so the replay side can re-validate it).
    """
    to_wire = getattr(obj, "to_wire", None)
    if callable(to_wire):
        return to_wire()
    if isinstance(obj, BaseModel):
        return obj.model_dump(mode="json", by_alias=True)
    return obj


class FixtureLlm:
    """The record/replay LlmPort implementation."""

    provider: str = "fixture"

    def __init__(
        self, dir: str | Path, *, record: bool = False, live: LlmPort | None = None
    ) -> None:
        self._dir = Path(dir)
        self._record = record
        self._live = live
        self.model_id: str = live.model_id if live is not None else "fixture"
        if record is True and live is None:
            raise LlmError("CONFIG", "FixtureLlm record mode requires a live LlmPort")

    def _key_of(self, parts: list[str | None]) -> str:
        # Identical to the TS implementation: join with NUL (U+0000) and take the first 24 hex digits of sha256.
        joined = _KEY_SEP.join(p if p is not None else "" for p in parts)
        return sha256_hex(joined)[:24]

    def _read(self, key: str) -> Any:
        path = self._dir / f"{key}.json"
        if not path.exists():
            return _MISSING
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as err:
            # Do not throw a raw exception on a corrupted fixture; fail explicitly, following the same philosophy as a schema mismatch.
            raise LlmError(
                "INVALID_OUTPUT", f"FixtureLlm: fixture {key}.json is corrupted (re-recording required)"
            ) from err

    def _write(self, key: str, value: object) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        (self._dir / f"{key}.json").write_text(text, encoding="utf-8")

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        key = self._key_of(["object", req.schema_name, req.system, req.prompt])
        recorded = self._read(key)
        if recorded is not _MISSING:
            obj = recorded["object"]
            if is_validating_schema(req.schema):
                try:
                    parsed = validate_against_schema(req.schema, obj)
                except SchemaValidationError as err:
                    # If a recorded response does not match the schema, do not swallow it; fail explicitly. This
                    # prevents a schema revision or a corrupted fixture from quietly flowing downstream as
                    # unvalidated data, which would break FixtureLlm's guarantee of "deterministic, type-safe replay".
                    raise LlmError(
                        "INVALID_OUTPUT",
                        f"FixtureLlm: recorded response does not match the schema (re-recording required): "
                        f"{str(err)[:200]}",
                    ) from err
                return GenerateObjectResult(object=parsed, usage=_USAGE, model=self.model_id)
            return GenerateObjectResult(object=obj, usage=_USAGE, model=self.model_id)
        if self._record is True and self._live is not None:
            result = await self._live.generate_object(req)
            self._write(key, {"object": _to_json_value(result.object), "prompt": req.prompt[:400]})
            return result
        raise LlmError(
            "INVALID_OUTPUT",
            f"FixtureLlm: no fixture for key {key} "
            f"(to record, construct with record=True, live=<real LlmPort> and run; "
            f"remove record when replaying)",
        )

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        key = self._key_of(["text", req.system, req.prompt])
        recorded = self._read(key)
        if recorded is not _MISSING:
            return GenerateTextResult(text=recorded["text"], usage=_USAGE)
        if self._record is True and self._live is not None:
            result = await self._live.generate_text(req)
            self._write(key, {"text": result.text, "prompt": req.prompt[:400]})
            return result
        raise LlmError(
            "INVALID_OUTPUT",
            f"FixtureLlm: no fixture for key {key} "
            f"(to record, construct with record=True, live=<real LlmPort> and run)",
        )
