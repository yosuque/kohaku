"""This product's design system (applied to L2 free generation. Identical in content to TS sample-api's design-system.ts).

The token vocabulary uses composer's default (DEFAULT_TOKEN_DESCRIPTIONS) as-is; here only the product-specific style
rules are added. The output writes styles with var(--kohaku-*), and the values are injected by the sandbox (TS renderer)
at render time — it follows light/dark switching without regeneration.

Whenever the content changes, be sure to bump the ds suffix of app.py's generatorVersion (a change in prompt content =
generation separation of the cache; the same operation as few-shot).

Never write a concrete value (a color, a px number) here — values live only in the tokens/kit, never in this guide.
"""

from __future__ import annotations

from kohaku.composer import DEFAULT_KIT_VOCABULARY, DesignSystemGuide

SALES_DESIGN_SYSTEM = DesignSystemGuide(
    # The built-in kit: kit classes + utilities the model composes with. The CSS is injected by the
    # sandbox at render time (renderer-core's defaultDesignKit — sample-web passes nothing, so the default applies).
    kit=DEFAULT_KIT_VOCABULARY,
    guidelines=[
        "Style table header rows with the k-table class (muted header on the surface color).",
        "When indicating increases/decreases, use k-kpi-delta with is-up / is-down (or var(--kohaku-color-positive) / var(--kohaku-color-negative)) and also show a symbol like ▲▼ (do not rely on color alone).",
    ],
)
