"""Token-building helpers shared by the authz_jwt tests (the Python counterpart of the TS tests' local
``hs256`` / jose ``SignJWT`` / ``generateKeyPair`` helpers)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Mapping
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey

SECRET = "test-secret-at-least-32-bytes-long-000"


def run[T](coro: Awaitable[T]) -> T:
    async def _wrap() -> T:
        return await coro

    return asyncio.run(_wrap())


def hs256(
    payload: Mapping[str, Any],
    *,
    iss: str | None = None,
    aud: str | None = None,
    exp_seconds: int = 300,
    secret: str = SECRET,
    alg: str = "HS256",
) -> str:
    """Signs ``payload`` with a shared secret; ``exp`` is ``exp_seconds`` from now (negative = already expired)."""
    claims: dict[str, Any] = {
        **payload,
        "iat": int(time.time()),
        "exp": int(time.time()) + exp_seconds,
    }
    if iss is not None:
        claims["iss"] = iss
    if aud is not None:
        claims["aud"] = aud
    return jwt.encode(claims, secret, algorithm=alg)


class RsaKeyPair:
    """An RSA signing key plus the public JWK (with ``kid`` / ``alg`` / ``use``) a JWKS would publish."""

    def __init__(self, kid: str = "k1") -> None:
        self.kid = kid
        self.private_key: RSAPrivateKey = rsa.generate_private_key(
            public_exponent=65537, key_size=2048
        )
        public = jwt.algorithms.RSAAlgorithm.to_jwk(self.private_key.public_key(), as_dict=True)
        self.jwk: dict[str, Any] = {**public, "kid": kid, "alg": "RS256", "use": "sig"}

    @property
    def jwks(self) -> dict[str, Any]:
        return {"keys": [self.jwk]}

    def sign(
        self,
        payload: Mapping[str, Any],
        *,
        aud: str | None = None,
        exp_seconds: int = 300,
        with_kid: bool = True,
        alg: str = "RS256",
        extra_claims: Mapping[str, Any] | None = None,
    ) -> str:
        claims: dict[str, Any] = {
            **payload,
            "exp": int(time.time()) + exp_seconds,
            **(extra_claims or {}),
        }
        if aud is not None:
            claims["aud"] = aud
        headers = {"kid": self.kid} if with_kid else None
        return jwt.encode(claims, self.private_key, algorithm=alg, headers=headers)


class EcKeyPair:
    """A P-256 signing key plus its public JWK, for the tests where the key type must not match an RSA token."""

    def __init__(self, kid: str = "ec1") -> None:
        self.kid = kid
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        public = jwt.algorithms.ECAlgorithm.to_jwk(self.private_key.public_key(), as_dict=True)
        self.jwk: dict[str, Any] = {**public, "kid": kid, "alg": "ES256", "use": "sig"}

    def sign(self, payload: Mapping[str, Any], *, aud: str | None = None) -> str:
        claims: dict[str, Any] = {**payload, "exp": int(time.time()) + 300}
        if aud is not None:
            claims["aud"] = aud
        return jwt.encode(claims, self.private_key, algorithm="ES256", headers={"kid": self.kid})
