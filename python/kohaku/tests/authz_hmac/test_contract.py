"""Runs the AuthzPort / ApprovalPort / CapabilityRevocationStore contract suites against the HMAC reference
adapters (port of TS packages/authz-hmac/test/contract.test.ts and memory-revocation-store.test.ts's contract
registration)."""

from __future__ import annotations

from kohaku.authz_hmac import (
    create_hmac_approval_port,
    create_hmac_authz_port,
    create_memory_approval_store,
    create_memory_revocation_store,
)
from kohaku.authz_hmac.authz_port import HmacAuthzPort
from kohaku.spec import ApprovalPort, CapabilityRevocationStore

from ._contract import (
    ApprovalPortContract,
    ApprovalSingleUseContract,
    AuthzPortContract,
    AuthzRevocationContract,
    AuthzTenantContract,
    FakeClock,
    RevocationStoreContract,
)


class TestHmacAuthzPortContract(AuthzPortContract, AuthzTenantContract, AuthzRevocationContract):
    def make_port(self, clock: FakeClock) -> HmacAuthzPort:
        return create_hmac_authz_port("contract-secret", now=clock)


class TestHmacApprovalPortContractNoStore(ApprovalPortContract):
    def make_port(self, clock: FakeClock) -> ApprovalPort:
        return create_hmac_approval_port("contract-secret", now=clock)


class TestHmacApprovalPortContractWithMemoryStore(ApprovalSingleUseContract):
    def make_port(self, clock: FakeClock) -> ApprovalPort:
        return create_hmac_approval_port(
            "contract-secret", store=create_memory_approval_store(clock), now=clock
        )


class TestMemoryRevocationStoreContract(RevocationStoreContract):
    def make_store(self) -> CapabilityRevocationStore:
        return create_memory_revocation_store()
