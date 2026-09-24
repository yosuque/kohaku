# @kohaku-ui/port-contracts

Shared vitest contract suites for kohaku's `StoragePort` and `AuthzPort` (spec-core's `ports.ts`). Each
suite (`describeStoragePortContract` / `describeAuthzPortContract`) registers a single top-level `describe`
block against a factory that produces a fresh port instance per test, so every adapter — the in-process
memory and file stores, the HMAC capability issuer, and future redis / postgres / JWT adapters — is checked
against exactly the same behavior instead of each writing its own ad hoc assertions.

This package is private and test-only: it is never published, holds no runtime behavior of its own, and
exists purely so the port contract is defined once and consumed from each implementation's own test suite
(e.g. `packages/storage-memory/test/contract.test.ts`, `packages/authz-hmac/test/contract.test.ts`).
