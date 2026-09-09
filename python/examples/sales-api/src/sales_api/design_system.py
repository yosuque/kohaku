"""This product's design system (applied to L2 free generation. Identical in content to TS sample-api's design-system.ts).

The token vocabulary uses composer's default (DEFAULT_TOKEN_DESCRIPTIONS) as-is; here only the product-specific style
rules are added. The output writes styles with var(--kohaku-*), and the values are injected by the sandbox (TS renderer)
at render time — it follows light/dark switching without regeneration.

Whenever the content changes, be sure to bump the ds suffix of app.py's generatorVersion (a change in prompt content =
generation separation of the cache; the same operation as few-shot).
"""

from __future__ import annotations

from kohaku.composer import DesignSystemGuide

SALES_DESIGN_SYSTEM = DesignSystemGuide(
    guidelines=[
        "Use spacing in multiples of 4px (4/8/12/16/24).",
        "Use an 8px corner radius and a 1px solid var(--kohaku-color-border) border by default.",
        "Use system-ui fonts (font-family: system-ui, sans-serif); body around 13px and headings around 15px.",
        "Style table header rows with background var(--kohaku-color-surface) and text var(--kohaku-color-muted).",
        "When indicating increases/decreases, use var(--kohaku-color-positive) / var(--kohaku-color-negative) and also show a symbol like ▲▼ (do not rely on color alone).",
    ],
)
