"""Static lint and extraction of L2-generated HTML (port of the pure-function part of TS l2-generate.ts).

collect_l2_issues checks the sandbox's window.kohaku bridge contract. It detects hallucinated APIs, a missing
ready(), truncated output, non-deterministic rendering, and traces of external libraries before delivery, and
sends them back as repair issues.

The TS version's L2_SCRIPT_SYNTAX (<script> JS syntax check) uses compilation via new Function, so
collect_l2_issues itself skips it here (per the "skip when dynamic code generation is unavailable" rule in
environments without a JS runtime. docs/specification.md §8. fail-open — do not break compose in environments
that cannot run the check). However, in an environment where Node is co-located, l2_js_sidecar (wired to
ComposePolicy.l2ScriptSyntax) can **symmetrize** it by delegating to the TS CLI (`kohaku smoke-l2 --lint`)
(Task #39). This function stays a pure function so behavior matches across languages, and the checks that
require JS execution are split out into injectable hooks.
"""

from __future__ import annotations

import re

from .design_system import DesignKitVocabulary

# Allowed APIs of the window.kohaku bridge (paired with the surface exposed by the sandbox's runtime.ts).
_KOHAKU_API_ALLOWLIST = frozenset({"fetchData", "emit", "onProps", "ready"})

_KOHAKU_METHOD_RE = re.compile(r"kohaku\s*\??\.\s*([A-Za-z_$][A-Za-z0-9_$]*)")
_HTML_CLOSED_RE = re.compile(r"</html>\s*$", re.IGNORECASE)
_MATH_RANDOM_RE = re.compile(r"Math\s*\.\s*random\s*\(")
# Navigation detection pattern (meta refresh / location assignment / window.open), mirrored verbatim from the
# TS L2_NAVIGATION_RE (packages/composer/src/tiers/l2-generate.ts) so the message and detection stay in sync
# across languages.
_L2_NAVIGATION_RE = re.compile(
    r"<meta\s+http-equiv\s*=\s*[\"']?\s*refresh"
    r"|location\s*\.\s*href\s*="
    r"|location\s*\.\s*assign\s*\("
    r"|location\s*\.\s*replace\s*\("
    r"|window\s*\.\s*open\s*\(",
    re.IGNORECASE,
)

# Markup the sandbox's DOM applier always rejects, mirrored verbatim from the TS L2_UNSAFE_MARKUP_RE
# (packages/composer/src/tiers/l2-generate.ts) — see that constant's docstring for why the on*= alternatives
# are scoped to an HTML-attribute or property-assignment context rather than a bare `on[a-z]+\s*=` anywhere.
_L2_UNSAFE_MARKUP_RE = re.compile(
    r"<(?:iframe|object|embed|form|base|link|frame|applet)\b"
    r"|<[a-zA-Z][^>]*\son[a-z]+\s*="
    r"|\.\s*on[a-z]+\s*=(?!=)"
    r"|javascript\s*:"
    r"|<script\b[^>]*\bsrc\s*=",
    re.IGNORECASE,
)

# APIs the sandbox's Worker DOM shim never provides, mirrored verbatim from the TS L2_UNSUPPORTED_DOM_RE.
_L2_UNSUPPORTED_DOM_RE = re.compile(
    r"\.\s*getContext\s*\("
    r"|document\s*\.\s*write\s*\("
    r"|\b(?:alert|confirm|prompt)\s*\("
    r"|\b(?:localStorage|sessionStorage|indexedDB)\b"
    r"|document\s*\.\s*cookie\b"
    r"|\b(?:MutationObserver|IntersectionObserver)\b"
)

# Traces of libraries unavailable in the sandbox (detection pattern and a label for repair feedback).
_L2_LIB_SIGNATURES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bd3\s*\."), "D3 (d3.*)"),
    (re.compile(r"new\s+Chart\s*\("), "Chart.js (new Chart)"),
    (re.compile(r"\becharts\s*\."), "ECharts (echarts.*)"),
    (re.compile(r"\bHighcharts\s*\."), "Highcharts"),
    # D3 / jQuery-style .attr("...") method chain (does not exist on plain DOM)
    (re.compile(r"\.attr\s*\(\s*[\"'`]"), "a D3/jQuery-style .attr() chain"),
]


def collect_l2_issues(
    html: str,
    *,
    enforce_token_colors: bool = False,
    kit: DesignKitVocabulary | None = None,
) -> list[str]:
    """Bridge-contract lint. Because it is a lexical check, it may react to strings inside comments, but a
    false positive only wastes one repair retry and never errs toward dropping a correct output.

    enforce_token_colors is the hard-coded-color check (L2_RAW_COLOR) for when the design system is applied.
    Default False (behavior with designSystem unset is completely unchanged). generate_l2 wires it from
    ComposePolicy.designSystem.

    kit is the unknown-kit-class check (L2_UNKNOWN_CLASS) for when a design kit is applied (only when
    ComposePolicy.designSystem.kit is set and enforceKitClasses is not explicitly False). Default None
    (behavior with no kit is completely unchanged).
    """
    issues: list[str] = []
    used = {m.group(1) for m in _KOHAKU_METHOD_RE.finditer(html)}
    for name in sorted(used):
        if name not in _KOHAKU_API_ALLOWLIST:
            issues.append(
                f"L2_UNKNOWN_API: window.kohaku.{name} does not exist (it will throw a TypeError at runtime). "
                "The only available APIs are fetchData / emit / onProps / ready. "
                f"Remove every occurrence of kohaku.{name}, including comments"
            )
    if "ready" not in used:
        issues.append(
            "L2_READY_MISSING: window.kohaku.ready() is never called. Always call window.kohaku.ready() directly "
            "when rendering completes (including when data fetching fails); destructuring or aliasing is not allowed"
        )
    # L2_SCRIPT_SYNTAX is skipped because there is no JS runtime (see the module docstring).
    if _HTML_CLOSED_RE.search(html) is None:
        issues.append(
            "L2_TRUNCATED: the HTML document does not end with </html> (output may be truncated). "
            "Output a complete single HTML document"
        )
    if _MATH_RANDOM_RE.search(html) is not None:
        issues.append(
            "L2_NONDETERMINISM: Math.random() is used. The widget must render deterministically "
            "from the actual data returned by fetchData (generating fake values from random numbers or dummy data is forbidden)"
        )
    if _L2_NAVIGATION_RE.search(html) is not None:
        issues.append(
            "L2_NAVIGATION: the document navigates (meta refresh / location assignment / window.open). "
            "Navigation APIs do not exist in the sandbox runtime; render in place and use window.kohaku.emit for interactions"
        )
    if _L2_UNSAFE_MARKUP_RE.search(html) is not None:
        issues.append(
            "L2_UNSAFE_MARKUP: the document contains markup the sandbox's DOM applier always rejects "
            "(an <iframe>/<object>/<embed>/<form>/<base>/<link>/<frame>/<applet> element, an on*= event-handler "
            "attribute, a javascript: URL, or a <script src=...>). None of these ever reach the real DOM "
            "(the applier drops them and the widget renders without them); use the DOM shim API's "
            "addEventListener and window.kohaku.emit instead"
        )
    if _L2_UNSUPPORTED_DOM_RE.search(html) is not None:
        issues.append(
            "L2_UNSUPPORTED_DOM: the code uses an API that does not exist in the sandbox's Worker DOM shim "
            "(canvas getContext, document.write, alert/confirm/prompt, localStorage/sessionStorage/indexedDB, "
            "document.cookie, or MutationObserver/IntersectionObserver). Calling any of these throws a TypeError "
            "at runtime; render only through the DOM shim API and window.kohaku"
        )
    for pattern, label in _L2_LIB_SIGNATURES:
        if pattern.search(html) is not None:
            issues.append(
                f"L2_LIB_UNAVAILABLE: the code uses {label}. The sandbox cannot load external libraries, "
                "and plain DOM elements have no .attr() or similar methods (it will throw a TypeError at runtime). "
                "Build SVG with document.createElementNS + setAttribute, or assemble a string and insert it via innerHTML"
            )
    # Hard-coded-color detection (only when the design system is applied; same pattern and message as TS).
    # Burning in concrete colors breaks theme-switch tracking and SPEC-ENV-003, so send it back to token references.
    if enforce_token_colors and _RAW_COLOR_RE.search(html) is not None:
        issues.append(
            "L2_RAW_COLOR: hard-coded colors (#hex / rgb() / hsl() etc.) are present. Always specify colors "
            "with design tokens var(--kohaku-*) (e.g. color: var(--kohaku-color-text), background "
            "var(--kohaku-color-background), chart series var(--kohaku-chart-palette-1) …)"
        )
    # Unknown kit class detection (only when a design kit is applied). A class in the kit's namespace that
    # the vocabulary does not define renders unstyled — exactly the "browser default look" the kit exists
    # to prevent — so send it back with the list of offenders. Classes outside the namespaces (the model's
    # own, styled in its <style>) are never flagged.
    if kit is not None:
        unknown = collect_unknown_kit_classes(html, kit)
        if unknown:
            issues.append(
                "L2_UNKNOWN_CLASS: these class names look like design-kit classes but do not exist in the kit: "
                + ", ".join(unknown)
                + ". Use only the component classes and utilities listed in the Design kit section, or rename "
                "them to your own classes and style those in <style> with var(--kohaku-*) tokens"
            )
    return issues


_RAW_COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(")
"""Hard-coded-color detection pattern (hex literal / rgb() / rgba() / hsl() / hsla(); same as TS's L2_RAW_COLOR_RE)."""

# class="…" / class='…' attributes, className = "…" assignments,
# classList.add/toggle/remove/replace("…", …) calls, and setAttribute("class", "…") calls (the form SVG
# elements must use, since className is read-only there). classList.toggle/remove/replace are scanned
# alongside add for the same reason as TS's CLASS_LIST_MUTATION_RE: a conditionally-applied kit class via
# toggle() is just as likely to be misspelled as one added via add(). Mirrored verbatim from TS's
# CLASS_ATTR_RE / CLASS_NAME_ASSIGN_RE / CLASS_LIST_MUTATION_RE / SET_CLASS_ATTR_RE
# (packages/composer/src/tiers/l2-generate.ts).
_CLASS_ATTR_RE = re.compile(r"\bclass\s*=\s*([\"'])([^\"']*)\1")
_CLASS_NAME_ASSIGN_RE = re.compile(r"\bclassName\s*=\s*([\"'`])([^\"'`]*)\1")
_CLASS_LIST_MUTATION_RE = re.compile(r"\bclassList\s*\.\s*(?:add|toggle|remove|replace)\s*\(([^)]*)\)")
_SET_CLASS_ATTR_RE = re.compile(r"\bsetAttribute\s*\(\s*([\"'])class\1\s*,\s*([\"'`])([^\"'`]*)\2\s*\)")
_STRING_LITERAL_RE = re.compile(r"([\"'`])([^\"'`]*)\1")


def collect_unknown_kit_classes(html: str, kit: DesignKitVocabulary) -> list[str]:
    """Collects the sorted, unique class names in the HTML that fall inside the kit's namespaces but are not
    defined by the vocabulary (component classes or utilities) — port of TS's collectUnknownKitClasses.
    Exported for the Python sidecar parity test and for products that want to pre-check a hand-written
    artifact.
    """
    known = set(kit.classes) | set(kit.utilities)
    found: set[str] = set()

    def consider(class_list: str) -> None:
        for cls in class_list.split():
            if cls == "" or cls in known:
                continue
            # A token carrying interpolation (`k-series-${i}`) or a trailing dash (a prefix awaiting
            # concatenation) resolves to a different string at runtime, so flagging its source text would
            # reject a valid widget and name a class the model never used.
            if "${" in cls or cls.endswith("-"):
                continue
            if any(cls.startswith(ns) for ns in kit.namespaces):
                found.add(cls)

    for m in _CLASS_ATTR_RE.finditer(html):
        consider(m.group(2))
    for m in _CLASS_NAME_ASSIGN_RE.finditer(html):
        consider(m.group(2))
    for m in _CLASS_LIST_MUTATION_RE.finditer(html):
        for lit in _STRING_LITERAL_RE.finditer(m.group(1)):
            consider(lit.group(2))
    for m in _SET_CLASS_ATTR_RE.finditer(html):
        consider(m.group(3))
    return sorted(found)

_FENCE_RE = re.compile(r"```(?:html)?\s*([\s\S]*?)```", re.IGNORECASE)
_DOCTYPE_RE = re.compile(r"<!DOCTYPE\s+html", re.IGNORECASE)
_HTML_OPEN_RE = re.compile(r"<html[\s>]", re.IGNORECASE)
_CLOSED_PREFIX_RE = re.compile(r"^[\s\S]*</html>", re.IGNORECASE)


def extract_html_document(text: str) -> str:
    """Extracts the HTML document body from the generated text.

    Even if the model wraps it in a code fence or preamble/postscript, adopt from the first <!DOCTYPE html>
    (or <html> if absent) to the last </html>. Detecting a missing close (truncation) is L2_TRUNCATED's job.
    """
    fenced = _FENCE_RE.search(text)
    body = (fenced.group(1) if fenced is not None else text).strip()
    doctype = _DOCTYPE_RE.search(body)
    html_open = _HTML_OPEN_RE.search(body) if doctype is None else None
    start = doctype.start() if doctype is not None else (
        html_open.start() if html_open is not None else -1
    )
    candidate = body[start:] if start >= 0 else body
    # Trailing postscript (explanatory text, etc.) is cut off at the last </html> (greedy match = last closing tag).
    closed = _CLOSED_PREFIX_RE.match(candidate)
    return (closed.group(0) if closed is not None else candidate).strip()


_TITLE_RE = re.compile(r"<title[^>]*>([\s\S]*?)</title>", re.IGNORECASE)
_WHITESPACE_RE = re.compile(r"\s+")


def extract_title(html: str, fallback: str) -> str:
    """Extracts the display title from the generated HTML's <title> (fallback if absent)."""
    m = _TITLE_RE.search(html)
    title = _WHITESPACE_RE.sub(" ", m.group(1)).strip() if m is not None else None
    return title[:120] if title else fallback
