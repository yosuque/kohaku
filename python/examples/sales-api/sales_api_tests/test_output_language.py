"""End-to-end output language (EN/JA) (mirrors TS: apps/sample-api/test/output-language.e2e.test.ts).

session.locale selects app.py's policy pair — JA gets JA L0 fixed specs with cache separation riding
the "/ja" generatorVersion token; EN stays byte-identical to the single-language era
(test_fixed_specs is the EN guard). The fixation shortcut is gated to EN sessions.
"""

from __future__ import annotations

import asyncio
import re

from kohaku.composer import ComposeContext, ComposeOptions, IntentComposeInput, compose
from kohaku.spec import IntentInput, SessionContext, UISpec
from kohaku.storage import MemoryStoragePort
from sales_api.app import create_app
from sales_api.authz_port import create_hmac_authz_port
from sales_api.fake_llm import create_deterministic_fake_llm
from sales_api.fixed_specs import language_of

_KPI = IntentComposeInput(
    intent=IntentInput(canonical="sales.kpi_overview", params={"fiscalYear": 2026, "quarter": 2})
)


def _heading_text(spec: UISpec) -> str:
    for c in spec.components:
        if c.type == "text.heading":
            return str((c.props or {}).get("text", ""))
    return ""


async def _make_ctx() -> ComposeContext:
    storage = MemoryStoragePort()
    authz = create_hmac_authz_port("test-secret")
    llm = create_deterministic_fake_llm()
    app = await create_app(llm=llm, storage=storage, authz=authz)
    return app.compose_ctx


class TestOutputLanguageL0:
    def test_ja_session_serves_ja_fixed_spec_and_en_default_stays_en(self) -> None:
        async def run() -> None:
            ctx = await _make_ctx()
            ja = await compose(
                _KPI, ctx, ComposeOptions(session=SessionContext(surface="web", locale="ja"))
            )
            assert _heading_text(ja.spec) == "2026年度Q2 業績サマリー"
            en = await compose(_KPI, ctx)
            assert _heading_text(en.spec) == "FY2026 Q2 Performance Summary"

        asyncio.run(run())

    def test_en_and_ja_cache_separately(self) -> None:
        async def run() -> None:
            ctx = await _make_ctx()
            en = await compose(
                _KPI, ctx, ComposeOptions(session=SessionContext(surface="web", locale="en"))
            )
            ja = await compose(
                _KPI, ctx, ComposeOptions(session=SessionContext(surface="web", locale="ja"))
            )
            assert en.trace.cacheKey != ja.trace.cacheKey
            # Both policies set designSystem (and EN also fewShot), so policy_fingerprint (a
            # belt-and-suspenders check on top of the manual generatorVersion bump both policies already do)
            # appends a 7th component after generatorVersion — hence a regex here rather than an exact
            # "/ds2" / "/ds2/ja" suffix match.
            assert re.search(r"/ds2:[0-9a-f]{16}$", en.trace.cacheKey)
            assert re.search(r"/ds2/ja:[0-9a-f]{16}$", ja.trace.cacheKey)
            # The EN entry was cached first; the JA request must have missed it.
            assert ja.spec.provenance.cache == "miss"
            ja_again = await compose(
                _KPI, ctx, ComposeOptions(session=SessionContext(surface="web", locale="ja"))
            )
            assert ja_again.spec.provenance.cache == "hit"
            assert _heading_text(ja_again.spec) == "2026年度Q2 業績サマリー"

        asyncio.run(run())


class TestLanguageOf:
    def test_maps_ja_prefix_and_defaults_to_en(self) -> None:
        assert language_of("ja") == "ja"
        assert language_of("ja-JP") == "ja"
        assert language_of("en") == "en"
        assert language_of("en-US") == "en"
        assert language_of("fr") == "en"
        assert language_of(None) == "en"
        # "jazz" must not prefix-match.
        assert language_of("jazz") == "en"
