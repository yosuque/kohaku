"""Port of TS packages/authz-jwt/test/identity.test.ts (PyJWT in place of jose), plus the cases where PyJWT's
defaults differ from jose's and the resolver pins jose's behaviour (see ``identity.py``'s decode options)."""

from __future__ import annotations

import http.server
import json
import threading
import time
from collections.abc import Iterator
from typing import Any

import jwt
import pytest

from kohaku.authz_jwt import (
    JwtClaimNames,
    JwtIdentityError,
    JwtJwksKey,
    JwtJwksUrlKey,
    JwtSecretKey,
    ResolvedIdentity,
    create_jwt_identity_resolver,
)
from kohaku.spec import Principal

from ._tokens import SECRET, RsaKeyPair, hs256, run

ISSUER = "https://issuer.test"


def _code_of(resolver: Any, token: str) -> str:
    with pytest.raises(JwtIdentityError) as info:
        run(resolver.resolve(token))
    return str(info.value.code)


class TestHs256SharedSecret:
    resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET), issuer=ISSUER, audience="kohaku")

    def test_maps_sub_name_roles_tenant_claims_to_a_principal_and_tenant(self) -> None:
        token = hs256(
            {"sub": "u1", "name": "Alice", "roles": ["reviewer", "viewer"], "tenant": "acme"},
            iss=ISSUER,
            aud="kohaku",
        )
        assert run(self.resolver.resolve(token)) == ResolvedIdentity(
            principal=Principal(id="u1", name="Alice", roles=["reviewer", "viewer"]), tenant="acme"
        )

    def test_accepts_a_space_separated_roles_string_and_omits_absent_optional_claims(self) -> None:
        token = hs256({"sub": "u2", "roles": "admin reviewer"}, iss=ISSUER, aud="kohaku")
        assert run(self.resolver.resolve(token)) == ResolvedIdentity(
            principal=Principal(id="u2", roles=["admin", "reviewer"])
        )

    def test_rejects_a_bad_signature_wrong_issuer_audience_and_an_expired_token_as_invalid_token(
        self,
    ) -> None:
        good: dict[str, Any] = {"iss": ISSUER, "aud": "kohaku"}
        other = create_jwt_identity_resolver(
            JwtSecretKey("another-secret-that-is-long-enough-0000")
        )
        forged = jwt.encode(
            {"sub": "x"}, "wrong-secret-that-is-long-enough-000000", algorithm="HS256"
        )
        for token in [
            forged,
            hs256({"sub": "u"}, **{**good, "iss": "https://evil.test"}),
            hs256({"sub": "u"}, **{**good, "aud": "someone-else"}),
            hs256({"sub": "u"}, **good, exp_seconds=-60),
        ]:
            assert _code_of(self.resolver, token) == "INVALID_TOKEN"
        with pytest.raises(JwtIdentityError):
            run(other.resolve("not-a-jwt"))

    def test_drops_non_string_entries_from_an_array_roles_claim_rather_than_coercing_them(
        self,
    ) -> None:
        token = hs256(
            {"sub": "u5", "roles": ["admin", 123, None, "viewer"]}, iss=ISSUER, aud="kohaku"
        )
        assert run(self.resolver.resolve(token)) == ResolvedIdentity(
            principal=Principal(id="u5", roles=["admin", "viewer"])
        )

    def test_a_caller_supplied_algorithms_list_controls_acceptance_directly(self) -> None:
        secret = (
            SECRET + "-padded-to-the-48-bytes-HS384-recommends"
        )  # PyJWT warns below 48 bytes for HS384
        token = hs256({"sub": "hs384"}, alg="HS384", secret=secret)

        excluding = create_jwt_identity_resolver(JwtSecretKey(secret), algorithms=["HS256"])
        assert _code_of(excluding, token) == "INVALID_TOKEN"

        including = create_jwt_identity_resolver(JwtSecretKey(secret), algorithms=["HS384"])
        assert run(including.resolve(token)).principal.id == "hs384"

    def test_rejects_a_token_without_a_subject_as_missing_subject(self) -> None:
        token = hs256({"roles": ["admin"]}, iss=ISSUER, aud="kohaku")
        assert _code_of(self.resolver, token) == "MISSING_SUBJECT"

    def test_from_authorization_header_missing_token_without_a_bearer_header_otherwise_resolves(
        self,
    ) -> None:
        with pytest.raises(JwtIdentityError) as info:
            run(self.resolver.from_authorization_header(None))
        assert info.value.code == "MISSING_TOKEN"
        token = hs256({"sub": "u3"}, iss=ISSUER, aud="kohaku")
        resolved = run(self.resolver.from_authorization_header(f"Bearer {token}"))
        assert resolved.principal.id == "u3"

    def test_honours_custom_claim_names_and_a_map_claims_override(self) -> None:
        custom = create_jwt_identity_resolver(
            JwtSecretKey(SECRET),
            claims=JwtClaimNames(roles="https://kohaku/roles", tenant="org_id"),
        )
        token = hs256({"sub": "u4", "https://kohaku/roles": ["viewer"], "org_id": "globex"})
        assert run(custom.resolve(token)) == ResolvedIdentity(
            principal=Principal(id="u4", roles=["viewer"]), tenant="globex"
        )

        mapped = create_jwt_identity_resolver(
            JwtSecretKey(SECRET),
            map_claims=lambda p: ResolvedIdentity(
                principal=Principal(id=f"user:{p['sub']}", roles=["admin"]), tenant="fixed"
            ),
        )
        assert run(mapped.resolve(token)) == ResolvedIdentity(
            principal=Principal(id="user:u4", roles=["admin"]), tenant="fixed"
        )


class TestJwtDefaultsThatDifferFromPyJwt:
    """PyJWT validates more than jose does by default (a string ``sub``, ``iat`` not in the future, an ``aud`` when
    none is configured). The resolver turns those off so a token verifies exactly as it would under the TS
    resolver: the mapping step, not the library, decides about ``sub``."""

    def test_a_token_carrying_aud_verifies_when_no_audience_is_configured_in_secret_mode(
        self,
    ) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET))
        assert run(resolver.resolve(hs256({"sub": "u"}, aud="anyone"))).principal.id == "u"

    def test_a_non_string_sub_is_missing_subject_not_invalid_token(self) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET))
        assert _code_of(resolver, hs256({"sub": 42})) == "MISSING_SUBJECT"
        assert _code_of(resolver, hs256({"sub": ""})) == "MISSING_SUBJECT"

    def test_an_iat_in_the_future_does_not_invalidate_the_token(self) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET))
        token = jwt.encode(
            {"sub": "u", "iat": int(time.time()) + 3600, "exp": int(time.time()) + 7200},
            SECRET,
            algorithm="HS256",
        )
        assert run(resolver.resolve(token)).principal.id == "u"

    def test_clock_tolerance_seconds_applies_to_exp_and_nbf(self) -> None:
        strict = create_jwt_identity_resolver(JwtSecretKey(SECRET))
        lenient = create_jwt_identity_resolver(JwtSecretKey(SECRET), clock_tolerance_seconds=30)
        expired = hs256({"sub": "u"}, exp_seconds=-10)
        assert _code_of(strict, expired) == "INVALID_TOKEN"
        assert run(lenient.resolve(expired)).principal.id == "u"

        not_yet = jwt.encode(
            {"sub": "u", "nbf": int(time.time()) + 10, "exp": int(time.time()) + 300},
            SECRET,
            algorithm="HS256",
        )
        assert _code_of(strict, not_yet) == "INVALID_TOKEN"
        assert run(lenient.resolve(not_yet)).principal.id == "u"

    def test_an_issuer_list_accepts_any_listed_issuer(self) -> None:
        resolver = create_jwt_identity_resolver(
            JwtSecretKey(SECRET), issuer=["https://a", "https://b"]
        )
        assert run(resolver.resolve(hs256({"sub": "u"}, iss="https://b"))).principal.id == "u"
        assert _code_of(resolver, hs256({"sub": "u"}, iss="https://c")) == "INVALID_TOKEN"

    def test_the_none_algorithm_is_never_accepted(self) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET))
        unsigned = jwt.encode({"sub": "u"}, key="", algorithm="none")
        assert _code_of(resolver, unsigned) == "INVALID_TOKEN"


class TestJwks:
    def test_verifies_an_rs256_token_against_a_local_jwk_set(self) -> None:
        pair = RsaKeyPair()
        resolver = create_jwt_identity_resolver(JwtJwksKey(pair.jwks), audience="kohaku")
        token = pair.sign({"sub": "rs", "roles": ["admin"]}, aud="kohaku")
        assert run(resolver.resolve(token)).principal == Principal(id="rs", roles=["admin"])

    def test_selects_the_key_by_kid_among_several(self) -> None:
        first, second = RsaKeyPair("k1"), RsaKeyPair("k2")
        resolver = create_jwt_identity_resolver(
            JwtJwksKey({"keys": [first.jwk, second.jwk]}), audience="kohaku"
        )
        assert (
            run(resolver.resolve(second.sign({"sub": "two"}, aud="kohaku"))).principal.id == "two"
        )
        assert run(resolver.resolve(first.sign({"sub": "one"}, aud="kohaku"))).principal.id == "one"

    def test_rejects_a_token_whose_kid_is_not_in_the_jwk_set(self) -> None:
        known, stranger = RsaKeyPair("k1"), RsaKeyPair("k9")
        resolver = create_jwt_identity_resolver(JwtJwksKey(known.jwks), audience="kohaku")
        assert _code_of(resolver, stranger.sign({"sub": "x"}, aud="kohaku")) == "INVALID_TOKEN"

    def test_a_token_signed_by_another_key_under_a_known_kid_is_rejected(self) -> None:
        known, impostor = RsaKeyPair("k1"), RsaKeyPair("k1")
        resolver = create_jwt_identity_resolver(JwtJwksKey(known.jwks), audience="kohaku")
        assert _code_of(resolver, impostor.sign({"sub": "x"}, aud="kohaku")) == "INVALID_TOKEN"

    def test_rejects_an_hs256_token_when_the_key_source_is_a_jwk_set(self) -> None:
        # The audience matches, so the algorithm allow-list is what rejects it (the TS test relies on the
        # missing audience as well).
        pair = RsaKeyPair()
        resolver = create_jwt_identity_resolver(JwtJwksKey(pair.jwks), audience="kohaku")
        assert _code_of(resolver, hs256({"sub": "u"}, aud="kohaku")) == "INVALID_TOKEN"

    def test_honours_a_caller_supplied_algorithms_list_that_narrows_the_jwks_default(self) -> None:
        pair = RsaKeyPair()
        resolver = create_jwt_identity_resolver(
            JwtJwksKey(pair.jwks), algorithms=["ES256"], audience="kohaku"
        )
        assert _code_of(resolver, pair.sign({"sub": "rs"}, aud="kohaku")) == "INVALID_TOKEN"

    def test_rejects_a_token_whose_aud_does_not_match_the_configured_audience(self) -> None:
        pair = RsaKeyPair()
        resolver = create_jwt_identity_resolver(JwtJwksKey(pair.jwks), audience="kohaku")
        assert _code_of(resolver, pair.sign({"sub": "rs"}, aud="someone-else")) == "INVALID_TOKEN"

    def test_a_single_key_without_kid_verifies_a_token_without_kid(self) -> None:
        pair = RsaKeyPair()
        jwks = {"keys": [{k: v for k, v in pair.jwk.items() if k != "kid"}]}
        resolver = create_jwt_identity_resolver(JwtJwksKey(jwks), audience="kohaku")
        token = pair.sign({"sub": "rs"}, aud="kohaku", with_kid=False)
        assert run(resolver.resolve(token)).principal.id == "rs"


class _JwksHandler(http.server.BaseHTTPRequestHandler):
    body: bytes = b"{}"
    hits: int = 0

    def do_GET(self) -> None:
        type(self).hits += 1
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(type(self).body)

    def log_message(self, format: str, *args: Any) -> None:  # silence the test server
        return


@pytest.fixture
def jwks_server() -> Iterator[tuple[str, type[_JwksHandler]]]:
    handler = type("Handler", (_JwksHandler,), {"hits": 0, "body": b"{}"})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/jwks.json", handler
    finally:
        server.shutdown()
        server.server_close()


class TestJwksUrl:
    """The remote JWKS path (PyJWKClient) that the TS tests only cover at construction time."""

    def test_fetches_the_jwk_set_from_the_url_and_verifies_a_token(
        self, jwks_server: tuple[str, type[_JwksHandler]]
    ) -> None:
        url, handler = jwks_server
        pair = RsaKeyPair()
        handler.body = json.dumps(pair.jwks).encode()
        resolver = create_jwt_identity_resolver(JwtJwksUrlKey(url), audience="kohaku")
        assert (
            run(resolver.resolve(pair.sign({"sub": "remote"}, aud="kohaku"))).principal.id
            == "remote"
        )
        # A second token reuses PyJWKClient's cached set rather than fetching again.
        run(resolver.resolve(pair.sign({"sub": "again"}, aud="kohaku")))
        assert handler.hits == 1

    def test_an_unknown_kid_cannot_make_the_service_refetch_inside_the_cooldown(
        self, jwks_server: tuple[str, type[_JwksHandler]]
    ) -> None:
        # A token's kid is read before its signature is verified, so an unauthenticated caller must not be
        # able to drive fetches against the issuer (PyJWKClient's 30s cooldown; the jwt extra's floor).
        url, handler = jwks_server
        known, stranger = RsaKeyPair("k1"), RsaKeyPair("k9")
        handler.body = json.dumps(known.jwks).encode()
        resolver = create_jwt_identity_resolver(JwtJwksUrlKey(url), audience="kohaku")
        run(resolver.resolve(known.sign({"sub": "ok"}, aud="kohaku")))
        assert handler.hits == 1
        for _ in range(5):
            assert _code_of(resolver, stranger.sign({"sub": "x"}, aud="kohaku")) == "INVALID_TOKEN"
        assert handler.hits == 1

    def test_a_rotated_in_key_is_picked_up_once_the_cooldown_has_passed(
        self, jwks_server: tuple[str, type[_JwksHandler]], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        url, handler = jwks_server
        old, new = RsaKeyPair("old"), RsaKeyPair("new")
        handler.body = json.dumps(old.jwks).encode()
        resolver = create_jwt_identity_resolver(JwtJwksUrlKey(url), audience="kohaku")
        run(resolver.resolve(old.sign({"sub": "a"}, aud="kohaku")))
        handler.body = json.dumps({"keys": [old.jwk, new.jwk]}).encode()
        assert _code_of(resolver, new.sign({"sub": "b"}, aud="kohaku")) == "INVALID_TOKEN"

        real_monotonic = time.monotonic
        monkeypatch.setattr(time, "monotonic", lambda: real_monotonic() + 31)
        assert run(resolver.resolve(new.sign({"sub": "b"}, aud="kohaku"))).principal.id == "b"

    def test_an_unreachable_jwks_url_is_invalid_token_not_a_crash(self) -> None:
        pair = RsaKeyPair()
        resolver = create_jwt_identity_resolver(
            JwtJwksUrlKey("http://127.0.0.1:9/jwks.json"), audience="kohaku"
        )
        assert _code_of(resolver, pair.sign({"sub": "x"}, aud="kohaku")) == "INVALID_TOKEN"


class TestConstructionTimeValidation:
    def test_throws_when_key_is_jwks_and_audience_is_omitted(self) -> None:
        with pytest.raises(ValueError, match="audience"):
            create_jwt_identity_resolver(JwtJwksKey(RsaKeyPair().jwks))

    def test_throws_when_key_is_jwks_url_and_audience_is_omitted(self) -> None:
        with pytest.raises(ValueError, match="audience"):
            create_jwt_identity_resolver(
                JwtJwksUrlKey("https://issuer.example.com/.well-known/jwks.json")
            )

    def test_does_not_throw_when_key_is_secret_and_audience_is_omitted(self) -> None:
        create_jwt_identity_resolver(JwtSecretKey(SECRET))

    def test_throws_when_the_hs256_secret_is_shorter_than_32_bytes(self) -> None:
        with pytest.raises(ValueError, match="32 bytes"):
            create_jwt_identity_resolver(JwtSecretKey("too-short"))

    def test_counts_secret_length_in_utf8_bytes(self) -> None:
        # 11 characters, 33 bytes: long enough, where a character count would reject it.
        create_jwt_identity_resolver(JwtSecretKey("あいうえおかきくけこさ"))

    def test_accepts_an_hs256_secret_of_exactly_32_bytes(self) -> None:
        create_jwt_identity_resolver(JwtSecretKey("a" * 32))

    def test_rejects_an_http_jwks_url_to_a_non_local_host(self) -> None:
        with pytest.raises(ValueError, match=r"https:"):
            create_jwt_identity_resolver(
                JwtJwksUrlKey("http://issuer.example.com/jwks.json"), audience="kohaku"
            )

    def test_rejects_a_non_http_jwks_url_scheme(self) -> None:
        # urllib (which PyJWKClient uses) would also open file: URLs; only https: / local http: is allowed.
        for url in ("file:///etc/passwd", "ftp://issuer.example.com/jwks.json"):
            with pytest.raises(ValueError, match=r"https:"):
                create_jwt_identity_resolver(JwtJwksUrlKey(url), audience="kohaku")

    def test_allows_an_http_jwks_url_to_localhost_127_0_0_1_and_ipv6_loopback(self) -> None:
        for host in ("localhost", "127.0.0.1", "[::1]"):
            create_jwt_identity_resolver(
                JwtJwksUrlKey(f"http://{host}:8080/jwks.json"), audience="kohaku"
            )

    def test_allows_an_https_jwks_url_to_any_host(self) -> None:
        create_jwt_identity_resolver(
            JwtJwksUrlKey("https://issuer.example.com/jwks.json"), audience="kohaku"
        )


class TestRequireTenant:
    def test_default_false_a_token_without_a_tenant_claim_resolves_with_no_tenant(self) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET))
        assert run(resolver.resolve(hs256({"sub": "u"}))) == ResolvedIdentity(
            principal=Principal(id="u")
        )

    def test_true_a_token_without_a_tenant_claim_rejects_with_missing_tenant(self) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET), require_tenant=True)
        assert _code_of(resolver, hs256({"sub": "u"})) == "MISSING_TENANT"

    def test_true_a_token_with_an_empty_string_tenant_claim_also_rejects_with_missing_tenant(
        self,
    ) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET), require_tenant=True)
        assert _code_of(resolver, hs256({"sub": "u", "tenant": ""})) == "MISSING_TENANT"

    def test_true_a_token_that_does_carry_a_tenant_claim_resolves_normally(self) -> None:
        resolver = create_jwt_identity_resolver(JwtSecretKey(SECRET), require_tenant=True)
        assert run(resolver.resolve(hs256({"sub": "u", "tenant": "acme"}))) == ResolvedIdentity(
            principal=Principal(id="u"), tenant="acme"
        )

    def test_map_claims_bypasses_require_tenant(self) -> None:
        resolver = create_jwt_identity_resolver(
            JwtSecretKey(SECRET),
            require_tenant=True,
            map_claims=lambda p: ResolvedIdentity(principal=Principal(id=str(p["sub"]))),
        )
        assert run(resolver.resolve(hs256({"sub": "u"}))).tenant is None
