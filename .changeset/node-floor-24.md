---
"@kohaku-ui/admin-react": minor
"@kohaku-ui/authz-hmac": minor
"@kohaku-ui/authz-jwt": minor
"@kohaku-ui/client": minor
"@kohaku-ui/composer": minor
"@kohaku-ui/data-binding": minor
"@kohaku-ui/evals": minor
"@kohaku-ui/host-a2ui": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host": minor
"@kohaku-ui/intents": minor
"@kohaku-ui/lineage": minor
"@kohaku-ui/llm": minor
"@kohaku-ui/mcp-renderer": minor
"@kohaku-ui/otel": minor
"@kohaku-ui/registry": minor
"@kohaku-ui/renderer-core": minor
"@kohaku-ui/renderer-react": minor
"@kohaku-ui/renderer-wc": minor
"@kohaku-ui/sandbox": minor
"@kohaku-ui/semantic-llm": minor
"@kohaku-ui/spec-core": minor
"@kohaku-ui/storage-memory": minor
"@kohaku-ui/storage-postgres": minor
"@kohaku-ui/storage-redis": minor
"@kohaku-ui/cli": minor
"@kohaku-ui/spec": minor
---

Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.
