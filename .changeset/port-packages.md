---
"@kohaku-ui/storage-memory": minor
"@kohaku-ui/authz-hmac": minor
---

New packages extracted from the sample: `@kohaku-ui/storage-memory` (`createMemoryStoragePort`, `createFileStoragePort`) and `@kohaku-ui/authz-hmac` (`createHmacAuthzPort`). They are reference implementations of `StoragePort` / `AuthzPort` (the contract stays in `@kohaku-ui/spec-core`) and pass the shared contract suites in the private `@kohaku-ui/port-contracts`.
