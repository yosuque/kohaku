"""Port of TS packages/authz-jwt/test/bearer.test.ts."""

from __future__ import annotations

from kohaku.authz_jwt import bearer_token


class TestBearerToken:
    def test_extracts_the_token_scheme_case_insensitively_trimming_whitespace(self) -> None:
        assert bearer_token("Bearer abc.def.ghi") == "abc.def.ghi"
        assert bearer_token("bearer   abc ") == "abc"

    def test_returns_none_for_a_missing_header_another_scheme_or_an_empty_token(self) -> None:
        assert bearer_token(None) is None
        assert bearer_token("Basic abc") is None
        assert bearer_token("Bearer ") is None

    def test_returns_none_when_the_token_part_contains_whitespace(self) -> None:
        # Not in the TS test, but pins the `^\s*bearer\s+(\S+)\s*$` shape: a second word is not a token.
        assert bearer_token("Bearer abc def") is None
