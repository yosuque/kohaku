"""Published-wheel smoke for the Python port (the PyPI half of .github/workflows/published-e2e.yml).

Run it isolated from the repository, against the wheel PyPI actually serves plus the newest upstream
dependencies the extras resolve to:

    uv run --isolated --no-project --with "kohaku-ui[rest,mcp,claude]" python -I scripts/published_e2e_python.py

`-I` keeps the script directory and the current directory off sys.path, so nothing from this repository's
`python/` tree can shadow the installed wheel (the script asserts that too). The checks mirror what a user of the
wheel does first:

  1. print `kohaku.__version__` and where the package was imported from;
  2. wire a minimal host (in-memory storage, an HMAC capability AuthzPort, a scripted FakeLlm, one DomainPort
     operation, one Intent served as an L0 fixed Spec) and mount it on FastAPI with `attach_kohaku_routes`;
  3. drive it with `fastapi.testclient.TestClient`: POST /compose answers 200 with `provenance.tier == "L0"`, and GET
     /binding/resolve with the issued capability answers 200;
  4. build the anthropic adapter on its default path (the real `anthropic` SDK) over an in-memory HTTP transport and
     assert that no sampling parameter (`temperature` / `top_p` / `top_k`) reaches the wire -- the regression
     guard for #104 (the Messages API rejects them from anthropic-version 2026-10-21, and SDK 2.x has no such
     keyword at all).

No check touches the network and none calls a real LLM. Exit code 0 means every check passed; any failure prints
what broke and exits 1.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

PREFIX = "/api/kohaku"
SOURCE = "published_e2e"
REF = f"query://{SOURCE}/summary?fy=2026"
INTENT_BODY: dict[str, Any] = {"canonical": f"{SOURCE}.summary", "params": {"fy": 2026}}
SAMPLING_KEYS = ("temperature", "top_p", "top_k")

failures: list[str] = []


def log(message: str) -> None:
    print(f"[published-e2e-python] {message}", flush=True)


def record_failure(message: str) -> None:
    failures.append(message)
    print(f"[published-e2e-python] FAIL: {message}", file=sys.stderr, flush=True)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def main() -> int:
    import kohaku

    version = getattr(kohaku, "__version__", None)
    location = Path(kohaku.__file__).resolve()
    log(f"kohaku.__version__ = {version!r} (imported from {location})")
    if version is None:
        record_failure("kohaku.__version__ is missing")
    # KOHAKU_E2E_ALLOW_SOURCE=1 lets a maintainer point this script at a source checkout to check the script itself.
    if "site-packages" not in location.parts and os.environ.get("KOHAKU_E2E_ALLOW_SOURCE") != "1":
        record_failure(
            f"kohaku was not imported from an installed wheel (site-packages): {location}"
        )

    check_rest_host()
    check_anthropic_sampling_params()

    if failures:
        print(f"\n[published-e2e-python] {len(failures)} check(s) failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    log("OK: every check passed")
    return 0


# --------------------------------------------------------------------------------------------------------
# 2-3. A minimal host mounted on FastAPI, driven over HTTP
# --------------------------------------------------------------------------------------------------------


def check_rest_host() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from kohaku.composer import ComposeContext, ComposePolicy
    from kohaku.host_rest import KohakuHostDeps, attach_kohaku_routes
    from kohaku.llm import FakeLlm
    from kohaku.registry import core_catalog, resolve_catalog
    from kohaku.spec import (
        SPEC_VERSION,
        DataShape,
        Intent,
        IntentInput,
        InvocationContext,
        JsonObject,
        OperationDescriptor,
        Principal,
        QueryHandle,
        Scope,
        SemanticInput,
        SessionContext,
        TabularData,
        UISpec,
        VerifyRequest,
        VerifyResult,
    )
    from kohaku.storage import MemoryStoragePort

    class DemoSemantic:
        """SemanticPort: one Intent, resolved to one query reference."""

        async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
            return IntentInput(
                canonical=INTENT_BODY["canonical"], params=dict(INTENT_BODY["params"])
            )

        async def resolve_query(
            self, intent: Intent, *, tenant: str | None = None
        ) -> QueryHandle | list[QueryHandle]:
            return QueryHandle(uri=REF)

        async def data_version(self, handle: QueryHandle) -> str:
            return "v1"

        async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
            return DataShape.model_validate(
                {
                    "columns": [
                        {"name": "region", "type": "string", "role": "dimension"},
                        {"name": "revenue", "type": "number", "role": "measure"},
                    ]
                }
            )

    class DemoDomain:
        """DomainPort: a single read operation."""

        async def list_operations(self) -> list[OperationDescriptor]:
            return [OperationDescriptor(name="summary", description="read")]

        async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
            if op != "summary":
                raise ValueError(f"unknown operation: {op}")
            return TabularData.model_validate(
                {
                    "columns": [
                        {"key": "region", "type": "string"},
                        {"key": "revenue", "type": "number"},
                    ],
                    "rows": [{"region": "us", "revenue": 100}],
                    "dataVersion": "v1",
                }
            )

    class HmacAuthz:
        """AuthzPort: base64url(payload).base64url(HMAC-SHA256) capability tokens, scopes matched exactly."""

        def __init__(self, secret: str) -> None:
            self._secret = secret.encode("utf-8")

        def _sign(self, payload: str) -> str:
            return _b64url(hmac.new(self._secret, payload.encode("utf-8"), hashlib.sha256).digest())

        async def issue_capability(
            self, principal: Principal, scopes: list[Scope], *, ttl_seconds: int | None = None
        ) -> str:
            claims = {
                "sub": principal.id,
                "scopes": [{"kind": s.kind, "ref": s.ref} for s in scopes],
                "exp": int(time.time()) + (ttl_seconds if ttl_seconds is not None else 600),
            }
            payload = _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
            return f"{payload}.{self._sign(payload)}"

        async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
            payload, _, signature = token.rpartition(".")
            if not payload or not hmac.compare_digest(
                signature.encode("utf-8"), self._sign(payload).encode("utf-8")
            ):
                return VerifyResult(ok=False, reason="invalid signature")
            claims = json.loads(_b64url_decode(payload))
            if claims["exp"] <= int(time.time()):
                return VerifyResult(ok=False, reason="capability expired")
            if any(s["kind"] == req.kind and s["ref"] == req.ref for s in claims["scopes"]):
                return VerifyResult(ok=True, principal=Principal(id=claims["sub"]))
            return VerifyResult(ok=False, reason="scope not granted")

    class FixedSpecs:
        """FixedSpecSource: the Intent is an L0 template -- it never reaches the LLM."""

        async def lookup(
            self, intent: Intent
        ) -> Callable[[Intent, list[QueryHandle]], UISpec] | None:
            if intent.canonical != INTENT_BODY["canonical"]:
                return None

            def build(i: Intent, refs: list[QueryHandle]) -> UISpec:
                return UISpec.model_validate(
                    {
                        "kohaku": SPEC_VERSION,
                        "intent": i.to_wire(),
                        "dataVersion": "template",
                        "components": [
                            {
                                "id": "root",
                                "type": "layout.stack",
                                "props": {},
                                "children": ["h", "t"],
                            },
                            {
                                "id": "h",
                                "type": "text.heading",
                                "props": {"level": 2, "text": "Published E2E summary"},
                            },
                            {
                                "id": "t",
                                "type": "presentSpreadsheet",
                                "props": {},
                                "data": {"$ref": refs[0].uri},
                            },
                        ],
                        "events": [],
                        "provenance": {
                            "tier": "L0",
                            "composedBy": "published-e2e",
                            "cache": "miss",
                        },
                    }
                )

            return build

    llm_calls: list[object] = []

    def scripted_object(req: object) -> dict[str, Any]:
        llm_calls.append(req)
        raise AssertionError("the L0 path must not call the LLM")

    ctx = ComposeContext(
        catalog=resolve_catalog(core_catalog()),
        semantic=DemoSemantic(),
        storage=MemoryStoragePort(),
        llm=FakeLlm(objects=scripted_object),
        policy=ComposePolicy(fixedSpecs=FixedSpecs()),
    )
    deps = KohakuHostDeps(
        compose=ctx,
        domain=DemoDomain(),
        authz=HmacAuthz("published-e2e-secret"),
        query_source=SOURCE,
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps, prefix=PREFIX)
    client = TestClient(app)

    compose = client.post(f"{PREFIX}/compose", json={"intent": INTENT_BODY})
    if compose.status_code != 200:
        record_failure(f"POST /compose answered {compose.status_code}: {compose.text[:300]}")
        return
    body = compose.json()
    tier = body.get("spec", {}).get("provenance", {}).get("tier")
    if tier != "L0":
        record_failure(f"POST /compose: provenance.tier is {tier!r}, expected 'L0'")
    capability = body.get("capability")
    if not isinstance(capability, str) or capability == "":
        record_failure("POST /compose did not issue a capability")
        return
    if llm_calls:
        record_failure("the L0 compose called the LLM")
    log(f"POST {PREFIX}/compose -> 200, provenance.tier == {tier!r}")

    resolved = client.get(
        f"{PREFIX}/binding/resolve",
        params={"ref": REF},
        headers={"authorization": f"Bearer {capability}"},
    )
    if resolved.status_code != 200:
        record_failure(
            f"GET /binding/resolve answered {resolved.status_code}: {resolved.text[:300]}"
        )
        return
    rows = resolved.json().get("rows")
    if not isinstance(rows, list) or len(rows) != 1:
        record_failure(f"GET /binding/resolve returned unexpected rows: {resolved.text[:300]}")
        return
    log(f"GET {PREFIX}/binding/resolve -> 200 ({len(rows)} row)")

    denied = client.get(f"{PREFIX}/binding/resolve", params={"ref": REF})
    if denied.status_code == 200:
        record_failure("GET /binding/resolve without a capability was not refused")
    else:
        log(f"GET {PREFIX}/binding/resolve without a capability -> {denied.status_code} (refused)")


# --------------------------------------------------------------------------------------------------------
# 4. The anthropic adapter sends no sampling parameters (#104)
# --------------------------------------------------------------------------------------------------------


def check_anthropic_sampling_params() -> None:
    import anthropic

    from kohaku.llm import GenerateObjectRequest, GenerateTextRequest, JsonSchema
    from kohaku.llm.adapters.anthropic_native import create_anthropic_native_llm
    from kohaku.llm.env import resolve_llm_env

    # anthropic SDK 2.x builds its HTTP layer on `httpx2`, earlier majors on `httpx`; use whichever the SDK's own
    # default async client is built from, so the in-memory transport is the type the SDK expects.
    try:
        import httpx2 as http_lib
    except ImportError:
        import httpx as http_lib

    config = resolve_llm_env(
        {"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "published-e2e"}
    )
    bodies: list[dict[str, Any]] = []
    tool_use = {"type": "tool_use", "id": "toolu_1", "name": "response", "input": {"ok": True}}
    text_block = {"type": "text", "text": "hello"}

    def message(content: list[dict[str, Any]], stop_reason: str) -> dict[str, Any]:
        return {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": config.model,
            "content": content,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": {"input_tokens": 5, "output_tokens": 7},
        }

    def handler(request: Any) -> Any:
        body = json.loads(request.content)
        bodies.append(body)
        if "tools" in body:
            return http_lib.Response(200, json=message([tool_use], "tool_use"))
        return http_lib.Response(200, json=message([text_block], "end_turn"))

    http_client = http_lib.AsyncClient(transport=http_lib.MockTransport(handler))
    real_cls = anthropic.AsyncAnthropic

    def build(**kwargs: Any) -> Any:
        return real_cls(**kwargs, http_client=http_client)

    anthropic.AsyncAnthropic = build  # type: ignore[misc,assignment]  # the adapter's lazy import reads this name
    try:

        async def run() -> None:
            llm = create_anthropic_native_llm(config)
            obj = await llm.generate_object(
                GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")
            )
            if obj.object != {"ok": True}:
                record_failure(f"generate_object returned {obj.object!r}, expected {{'ok': True}}")
            # An explicit per-call temperature is accepted by the port but must never reach the wire.
            text = await llm.generate_text(GenerateTextRequest(prompt="p", temperature=0.7))
            if text.text != "hello":
                record_failure(f"generate_text returned {text.text!r}, expected 'hello'")

        try:
            asyncio.run(run())
        except Exception as err:  # noqa: BLE001 -- any failure of the call itself is the finding
            sampling = "temperature" in str(err)
            record_failure(
                "the anthropic adapter could not complete a call against the in-memory transport "
                f"(anthropic SDK {anthropic.__version__})"
                + (
                    "; the error names `temperature`, so this is the #104 regression (the adapter "
                    "forwards a sampling parameter the SDK / API refuse)"
                    if sampling
                    else ""
                )
                + f": {type(err).__name__}: {err}"
            )
            traceback.print_exc()
            return
    finally:
        anthropic.AsyncAnthropic = real_cls  # type: ignore[misc]

    if len(bodies) != 2:
        record_failure(f"expected 2 requests on the wire (object + text), saw {len(bodies)}")
    sent = sorted({key for body in bodies for key in SAMPLING_KEYS if key in body})
    if sent:
        record_failure(
            f"the anthropic adapter sent sampling parameter(s) {sent} on the wire "
            "(#104: the Messages API rejects them from anthropic-version 2026-10-21)"
        )
    else:
        log(
            f"anthropic adapter (SDK {anthropic.__version__}, {http_lib.__name__} transport): "
            f"{len(bodies)} request(s), none carries {'/'.join(SAMPLING_KEYS)}"
        )


if __name__ == "__main__":
    sys.exit(main())
