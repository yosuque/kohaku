"""HMAC-SHA256 reference AuthzPort / ApprovalPort (port of TS @kohaku-ui/authz-hmac).

``create_hmac_authz_port`` issues and verifies the capability token (with ``jti`` / ``tenant`` claims and
pre-expiry revocation through a `CapabilityRevocationStore`); ``create_hmac_approval_port`` issues and verifies
the single-purpose approval token for "approve"-tier Actions (derived MAC key, optional single-use `ApprovalStore`).
Both are byte-compatible with the TS ports. Depends on ``kohaku.spec`` only, so a product can wire it without
pulling a host in.
"""

from kohaku.spec import (
    DEFAULT_APPROVAL_TTL_SECONDS,
    DEFAULT_CAPABILITY_TTL_SECONDS,
    ApprovalStore,
    CapabilityRevocationStore,
    RevokeCapabilityResult,
)

from .approval_port import (
    APPROVAL_KEY_LABEL,
    APPROVAL_TOKEN_PREFIX,
    DEFAULT_MAX_APPROVAL_TTL_SECONDS,
    HmacApprovalPort,
    create_hmac_approval_port,
)
from .approval_store import MemoryApprovalStore, create_memory_approval_store
from .authz_port import HmacAuthzPort, create_hmac_authz_port
from .revocation_store import MemoryRevocationStore, create_memory_revocation_store

__all__ = [
    "APPROVAL_KEY_LABEL",
    "APPROVAL_TOKEN_PREFIX",
    "DEFAULT_APPROVAL_TTL_SECONDS",
    "DEFAULT_CAPABILITY_TTL_SECONDS",
    "DEFAULT_MAX_APPROVAL_TTL_SECONDS",
    "ApprovalStore",
    "CapabilityRevocationStore",
    "HmacApprovalPort",
    "HmacAuthzPort",
    "MemoryApprovalStore",
    "MemoryRevocationStore",
    "RevokeCapabilityResult",
    "create_hmac_approval_port",
    "create_hmac_authz_port",
    "create_memory_approval_store",
    "create_memory_revocation_store",
]
