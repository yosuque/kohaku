"""Tests for the L2 static lint (collect_l2_issues / extract_html_document / extract_title)."""

from __future__ import annotations

import pytest

from kohaku.composer.l2_lint import collect_l2_issues, extract_html_document, extract_title

_VALID_HTML = (
    "<!DOCTYPE html><html><head><title>Sales</title></head><body><div id=x></div>"
    "<script>window.kohaku.fetchData('query://s/p').then(function(d){"
    "document.getElementById('x').textContent=d.rows.length;window.kohaku.ready();});"
    "</script></body></html>"
)


class TestCollectL2Issues:
    def test_valid_html_has_no_issues(self) -> None:
        assert collect_l2_issues(_VALID_HTML) == []

    def test_unknown_api(self) -> None:
        html = _VALID_HTML.replace("window.kohaku.ready()", "window.kohaku.onReady()")
        issues = collect_l2_issues(html)
        assert any("L2_UNKNOWN_API" in i and "onReady" in i for i in issues)
        assert any("L2_READY_MISSING" in i for i in issues)

    def test_ready_missing(self) -> None:
        html = _VALID_HTML.replace("window.kohaku.ready();", "")
        issues = collect_l2_issues(html)
        assert any(i.startswith("L2_READY_MISSING") for i in issues)

    def test_truncated(self) -> None:
        html = _VALID_HTML[: len(_VALID_HTML) - len("</html>")]
        issues = collect_l2_issues(html)
        assert any(i.startswith("L2_TRUNCATED") for i in issues)

    def test_nondeterminism(self) -> None:
        html = _VALID_HTML.replace("d.rows.length", "Math.random()")
        issues = collect_l2_issues(html)
        assert any(i.startswith("L2_NONDETERMINISM") for i in issues)

    def test_lib_unavailable(self) -> None:
        html = _VALID_HTML.replace(
            "d.rows.length", 'd3.select("#x") && svg.append("rect").attr("width", 10)'
        )
        issues = collect_l2_issues(html)
        assert any(i.startswith("L2_LIB_UNAVAILABLE") for i in issues)

    def test_navigation(self) -> None:
        meta_refresh = _VALID_HTML.replace(
            "<head>", '<head><meta http-equiv="refresh" content="0;url=https://evil.example">'
        )
        assert any(i.startswith("L2_NAVIGATION") for i in collect_l2_issues(meta_refresh))

        location_href = _VALID_HTML.replace(
            "d.rows.length", 'd.rows.length; location.href = "https://evil.example"'
        )
        assert any(i.startswith("L2_NAVIGATION") for i in collect_l2_issues(location_href))

        location_assign = _VALID_HTML.replace(
            "d.rows.length", 'd.rows.length; location.assign("https://evil.example")'
        )
        assert any(i.startswith("L2_NAVIGATION") for i in collect_l2_issues(location_assign))

        location_replace = _VALID_HTML.replace(
            "d.rows.length", 'd.rows.length; location.replace("https://evil.example")'
        )
        assert any(i.startswith("L2_NAVIGATION") for i in collect_l2_issues(location_replace))

        window_open = _VALID_HTML.replace(
            "d.rows.length", 'd.rows.length; window.open("https://evil.example")'
        )
        assert any(i.startswith("L2_NAVIGATION") for i in collect_l2_issues(window_open))

    def test_navigation_absent_for_plain_widget(self) -> None:
        assert all("L2_NAVIGATION" not in i for i in collect_l2_issues(_VALID_HTML))

    def test_script_syntax_error_is_not_flagged(self) -> None:
        """L2_SCRIPT_SYNTAX is not emitted even for HTML containing a broken <script>.

        L2_SCRIPT_SYNTAX (JS syntax check) requires new-Function-equivalent compilation, and in Python, which
        has no JS runtime, it is skipped per the spec rule "skip in environments where dynamic code generation
        is unavailable" (an intentional difference = expected behavior; see the module docstring of l2_lint.py /
        the L2_SCRIPT_SYNTAX skip note). The TS side (packages/composer/test/l2-repair.test.ts, describe
        "collectL2Issues (L2 bridge-contract lint)" > it "detects a raw newline inside a string literal (a
        SyntaxError observed in the field) as L2_SCRIPT_SYNTAX") conversely pins the detection expectation
        (emitting L2_SCRIPT_SYNTAX on a syntax error), and this asymmetry is explicitly pinned by a regression
        test.
        """
        # An unterminated string literal (a '<div> containing a newline) = a JS syntax error. It calls ready(),
        # closes with </html>, and uses only known APIs, so it does not touch the non-syntax lints (READY/TRUNCATED/UNKNOWN_API).
        broken = (
            "<!DOCTYPE html><html><body><script>\n"
            "let s = '<div>\n"
            "';\n"
            "window.kohaku.ready();\n"
            "</script></body></html>"
        )
        issues = collect_l2_issues(broken)
        assert all("L2_SCRIPT_SYNTAX" not in i for i in issues)
        # Complete HTML that matches no non-syntax lint either, so issues is empty (making the effect of the skip explicit).
        assert issues == []


class TestUnsafeMarkup:
    """L2_UNSAFE_MARKUP: markup the sandbox's DOM applier always rejects. Mirrors the TS pair in
    packages/composer/test/l2-repair.test.ts."""

    @pytest.mark.parametrize(
        "tag", ["iframe", "object", "embed", "form", "base", "link", "frame", "applet"]
    )
    def test_denied_element(self, tag: str) -> None:
        html = f"<!DOCTYPE html><html><body><{tag}></{tag}><script>window.kohaku.ready();</script></body></html>"
        assert any(i.startswith("L2_UNSAFE_MARKUP") for i in collect_l2_issues(html))

    def test_on_attr_and_property_assignment(self) -> None:
        attr_html = (
            '<!DOCTYPE html><html><body><button onclick="doEvil()">go</button>'
            "<script>window.kohaku.ready();</script></body></html>"
        )
        assert any(i.startswith("L2_UNSAFE_MARKUP") for i in collect_l2_issues(attr_html))

        prop_html = (
            "<!DOCTYPE html><html><body><script>"
            'var b = document.createElement("button"); b.onclick = function () {};'
            "window.kohaku.ready();</script></body></html>"
        )
        assert any(i.startswith("L2_UNSAFE_MARKUP") for i in collect_l2_issues(prop_html))

    def test_javascript_url_and_script_src(self) -> None:
        js_url = (
            "<!DOCTYPE html><html><body><script>"
            'var a = "javascript:alert(1)"; window.kohaku.ready();'
            "</script></body></html>"
        )
        assert any(i.startswith("L2_UNSAFE_MARKUP") for i in collect_l2_issues(js_url))

        script_src = (
            '<!DOCTYPE html><html><body><script src="https://evil.example/x.js"></script>'
            "<script>window.kohaku.ready();</script></body></html>"
        )
        assert any(i.startswith("L2_UNSAFE_MARKUP") for i in collect_l2_issues(script_src))

    def test_no_false_positive_on_onprops_or_idiomatic_variable_name(self) -> None:
        html = (
            "<!DOCTYPE html><html><body><script>"
            "function onRowClick(e) { window.kohaku.emit('select', { row: e }); }"
            "const onSubmit = function () {};"
            "window.kohaku.onProps(function (props) {});"
            "window.kohaku.ready();"
            "</script></body></html>"
        )
        assert all("L2_UNSAFE_MARKUP" not in i for i in collect_l2_issues(html))


class TestUnsupportedDom:
    """L2_UNSUPPORTED_DOM: APIs the sandbox's Worker DOM shim does not provide. Mirrors the TS pair."""

    @pytest.mark.parametrize(
        "snippet",
        [
            'document.getElementById("c").getContext("2d")',
            "document.write('<p>hi</p>')",
            "alert('hi')",
            "confirm('ok?')",
            "prompt('name?')",
            "localStorage.setItem('a', '1')",
            "sessionStorage.setItem('a', '1')",
            "indexedDB.open('db')",
            "var c = document.cookie",
            "new MutationObserver(function () {})",
            "new IntersectionObserver(function () {})",
        ],
    )
    def test_detects_unsupported_api(self, snippet: str) -> None:
        html = f"<!DOCTYPE html><html><body><script>{snippet}; window.kohaku.ready();</script></body></html>"
        assert any(i.startswith("L2_UNSUPPORTED_DOM") for i in collect_l2_issues(html))

    def test_no_false_positive_on_plain_widget(self) -> None:
        assert all("L2_UNSUPPORTED_DOM" not in i for i in collect_l2_issues(_VALID_HTML))


class TestRawColorLint:
    """Hard-coded-color check (L2_RAW_COLOR; enabled only when the design system is applied). The TS-side pair
    is packages/composer/test/design-system.test.ts."""

    _TOKEN_HTML = _VALID_HTML.replace(
        "<head>",
        "<head><style>body{background:var(--kohaku-color-background);"
        "color:var(--kohaku-color-text);}</style>",
    )
    _RAW_HTML = _VALID_HTML.replace(
        "<head>", "<head><style>body{background:#ffffff;color:rgb(26, 26, 46);}</style>"
    )

    def test_disabled_by_default(self) -> None:
        """By default (enforce_token_colors=False), hard-coded colors are not flagged (behavior unchanged)."""
        assert collect_l2_issues(self._RAW_HTML) == []
        assert collect_l2_issues(self._RAW_HTML, enforce_token_colors=False) == []

    def test_detects_hex_and_rgb(self) -> None:
        issues = collect_l2_issues(self._RAW_HTML, enforce_token_colors=True)
        assert any(i.startswith("L2_RAW_COLOR") for i in issues)

    def test_detects_hsl(self) -> None:
        html = _VALID_HTML.replace(
            "<head>", "<head><style>body{color:hsl(220, 10%, 20%);}</style>"
        )
        issues = collect_l2_issues(html, enforce_token_colors=True)
        assert any(i.startswith("L2_RAW_COLOR") for i in issues)

    def test_token_references_pass(self) -> None:
        assert collect_l2_issues(self._TOKEN_HTML, enforce_token_colors=True) == []

    def test_css_id_selector_is_not_flagged(self) -> None:
        """A CSS id selector (#chart, etc.) is not falsely detected as a hex literal."""
        html = self._TOKEN_HTML.replace("body{", "#chart{padding:8px;} body{")
        assert collect_l2_issues(html, enforce_token_colors=True) == []


class TestExtractHtmlDocument:
    def test_plain_document_passes_through(self) -> None:
        assert extract_html_document(_VALID_HTML) == _VALID_HTML

    def test_strips_code_fence(self) -> None:
        assert extract_html_document(f"```html\n{_VALID_HTML}\n```") == _VALID_HTML

    def test_strips_prose_before_and_after(self) -> None:
        text = f"Here is the generated output.\n{_VALID_HTML}\nPlease review."
        assert extract_html_document(text) == _VALID_HTML

    def test_html_without_doctype(self) -> None:
        html = _VALID_HTML.removeprefix("<!DOCTYPE html>")
        assert extract_html_document(f"preamble\n{html}") == html


class TestExtractTitle:
    def test_extracts_title(self) -> None:
        assert extract_title(_VALID_HTML, "fallback") == "Sales"

    def test_fallback_when_missing(self) -> None:
        assert extract_title("<html></html>", "Custom view") == "Custom view"

    def test_collapses_whitespace_and_truncates(self) -> None:
        html = "<html><head><title>  a\n  b  </title></head></html>"
        assert extract_title(html, "f") == "a b"
