"""JWT / OIDC identity resolution and the AuthzPort built on it (port of TS @kohaku-ui/authz-jwt).

`create_jwt_identity_resolver` verifies a bearer JWT (shared secret, inline JWK set, or remote JWKS) with PyJWT and
maps its claims to a `Principal` + tenant; `create_jwt_authz_port` pairs that resolver with the HMAC capability
tokens of ``kohaku.authz_hmac`` (which it delegates to entirely). Requires the optional ``jwt`` extra
(``pip install 'kohaku-ui[jwt]'``). Depends on ``kohaku.spec`` and ``kohaku.authz_hmac`` only, so a product can wire
it without pulling a host in.
"""

from .authz_port import JwtAuthzPort, create_jwt_authz_port
from .bearer import bearer_token
from .identity import (
    JwtClaimNames,
    JwtIdentityError,
    JwtIdentityErrorCode,
    JwtIdentityResolver,
    JwtJwksKey,
    JwtJwksUrlKey,
    JwtKeySource,
    JwtSecretKey,
    ResolvedIdentity,
    create_jwt_identity_resolver,
)

__all__ = [
    "JwtAuthzPort",
    "JwtClaimNames",
    "JwtIdentityError",
    "JwtIdentityErrorCode",
    "JwtIdentityResolver",
    "JwtJwksKey",
    "JwtJwksUrlKey",
    "JwtKeySource",
    "JwtSecretKey",
    "ResolvedIdentity",
    "bearer_token",
    "create_jwt_authz_port",
    "create_jwt_identity_resolver",
]
