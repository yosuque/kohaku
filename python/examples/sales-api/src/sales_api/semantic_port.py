"""SemanticPort implementation (port of TS: apps/sample-api/src/ports/semantic-port.ts).

GUI actions are normalized deterministically without going through the LLM; natural language is mapped to the Intent
catalog by the LLM; both converge into the same IntentInput (= a CanonicalIntent before its hash is filled in) (the core of R5).

The port itself is `kohaku.semantic_llm`'s default SemanticPort (`create_llm_semantic_port`, port of TS
@kohaku-ui/semantic-llm). What stays product-specific here, as in the TS sample: the sales rules of the
normalization prompt (fiscal calendar from an injectable clock, region name normalization, the sales.custom escape
hatch), the shape lookup and the data version. The generic prompt wording (opening/closing lines, the USER_QUESTION
delimiter block) comes from the library and is character-identical to TS.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from kohaku.llm import LlmPort
from kohaku.semantic_llm import LlmSemanticPort, UnknownIntentError, create_llm_semantic_port
from kohaku.spec import SessionContext

from .domain import SalesRepo, fiscal_year_of, quarter_of, shape_of
from .fixed_specs import language_of
from .intents_catalog import FISCAL_YEAR_MAX, FISCAL_YEAR_MIN, IntentCatalog

SalesSemanticPort = LlmSemanticPort
"""The sales sample's port is the library's default port, configured with the sales rules below."""


@dataclass(frozen=True)
class FiscalPeriod:
    fiscal_year: int
    quarter: int
    year: int
    """The calendar year (for the prompt's current-year/month notation. Distinct from the fiscal year)."""
    month: int


def fiscal_period_of(date: datetime) -> FiscalPeriod:
    """Runtime computation of the fiscal period, delegating the FY-label and quarter conventions to
    domain.py's fiscal_year_of/quarter_of (the single source, also used by TS's scripts/generate-seed.ts
    counterpart) so this real-clock reading and the seed's own fiscal calendar cannot drift apart.

    Used to derive the NL normalization prompt's "this period" / "this quarter" / "last year" from the current time
    rather than from a fixed string.

    Timezone note: `date.year`/`date.month` are read as given (whatever timezone `date` carries, naive or aware;
    the default caller passes `datetime.now()`, i.e. the server process's local time, not UTC). Around the April 1
    fiscal-year boundary (and, less critically, the other quarter boundaries), a request made in the last hours of
    March 31 or the first hours of April 1 local time can therefore land on either side of the boundary depending
    on the server's timezone, even though the underlying instant is the same. This only affects the NL-normalization
    prompt's "this period"/"this quarter" hint (not the seed data or any stored value), and the demo seed's fixed
    FY2025-FY2026 range is unaffected either way. Mirrors TS fiscalPeriodOf.
    """
    year = date.year
    month = date.month  # 1 to 12
    return FiscalPeriod(
        fiscal_year=fiscal_year_of(year, month), quarter=quarter_of(month), year=year, month=month
    )


def _clamp_fiscal_year(year: int) -> int:
    """Clamps the fiscal year to vocab's value range (FISCAL_YEAR_MIN to MAX) (TS: clampFiscalYear).

    The range is taken from intents_catalog (vocab's single source; fiscal_year's min/max = the seed's range).
    fiscal_period_of derives the fiscal year from the real clock, so it can return a year beyond the range the seed
    holds (FY2025 to FY2026) (e.g. April 2027 onward is FY2027). The seed is fixed-generated time-independently, so
    out-of-range fiscal years do not exist. We round here before injecting into the NL normalization prompt so the LLM
    is not made to choose a non-existent fiscal year (outside the fiscalYear enum). fiscal_period_of itself, as a pure
    fiscal-period computation, returns out-of-range values as-is.
    """
    return min(FISCAL_YEAR_MAX, max(FISCAL_YEAR_MIN, year))


def _sales_rules(date: datetime) -> list[str]:
    """The sales-domain lines of the normalization prompt (unchanged wording)."""
    period = fiscal_period_of(date)
    # "this period" / "this quarter" / "last year" are computed at runtime from the current time (an injectable clock) rather than fixed strings.
    # Even if the real clock exceeds the seed range (FY2025 to FY2026), clamp to vocab's value range so a non-existent
    # fiscal year is not chosen (e.g. FY2027 at the time of 2027 -> FY2026). The previous year subtracts 1 from the
    # clamped current fiscal year and clamps again, also preventing under-run (FY2024, etc.). The quarter and calendar
    # year/month are informational display, so they are not rounded.
    current_fiscal_year = _clamp_fiscal_year(period.fiscal_year)
    prev_fiscal_year = _clamp_fiscal_year(current_fiscal_year - 1)
    return [
        f"- The fiscal year starts in April (FY{current_fiscal_year} = {current_fiscal_year}-04 to "
        f'{current_fiscal_year + 1}-03). "this period"/"this fiscal year" (今期/今年度) = fiscalYear={current_fiscal_year}; '
        f'"this quarter" (今四半期) = quarter={period.quarter} (now {period.year}-{period.month}).',
        f'- "last year"/"prior fiscal year" (前年/昨年度) = fiscalYear={prev_fiscal_year}',
        "- Normalize region names to japan / north_america / europe / apac (日本→japan, 北米→north_america, 欧州/ヨーロッパ→europe, アジア太平洋→apac)",
        "- For a visualization request that fits no Intent (a heatmap, matrix, or other bespoke form),"
        " choose sales.custom and put the original request text verbatim into params.request",
    ]


def create_semantic_port(
    *,
    repo: SalesRepo,
    catalog_for: Callable[[str | None], IntentCatalog],
    llm: LlmPort,
    now: Callable[[], datetime] | None = None,
) -> SalesSemanticPort:
    """Builds the sales SemanticPort on kohaku.semantic_llm.

    catalog_for: per-tenant Intent catalog resolution (promoted Intents are per-tenant, so it returns base +
    promotions). now: the source of the current time (resolving the NL normalization's "this period"); the
    default is the real clock, tests inject a fixed datetime.
    """
    clock = now if now is not None else datetime.now

    def rules(_ctx: SessionContext) -> list[str]:
        return _sales_rules(clock())

    return create_llm_semantic_port(
        llm=llm,
        catalog=catalog_for,
        # Common to all queries because there is a single domain.
        data_version=lambda _handle: repo.data_version(),
        describe_shape=lambda ref: shape_of(ref.path, ref.params),
        rules=rules,
        fallback_intent="sales.custom",
        # Locale hint precedence (per-input NLQuery.locale over the session's) is the library's; language_of
        # normalizes any locale tag to its "ja"/"en" prompt hint (e.g. "ja-JP" -> "ja"), consistent with how the
        # rest of the app resolves output language for the same session.
        output_locale=language_of,
    )


__all__ = [
    "FiscalPeriod",
    "SalesSemanticPort",
    "UnknownIntentError",
    "create_semantic_port",
    "fiscal_period_of",
]
