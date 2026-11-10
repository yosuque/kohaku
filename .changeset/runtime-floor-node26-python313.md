---
"@kohaku-ui/admin-react": minor
"@kohaku-ui/authz-hmac": minor
"@kohaku-ui/authz-jwt": minor
"@kohaku-ui/client": minor
"@kohaku-ui/composer": minor
"@kohaku-ui/data-binding": minor
"@kohaku-ui/domain-mcp": minor
"@kohaku-ui/evals": minor
"@kohaku-ui/host": minor
"@kohaku-ui/host-a2ui": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/host-rest": minor
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

Raise the minimum runtimes: Node from 24.22.1 to **26.12.1** and Python (the `kohaku-ui` distribution) from 3.12 to **3.13**. Every published package's `engines.node` is now `>=26.12.1`, and so is the `package.json` that `kohaku init` generates; `kohaku-ui` now declares `requires-python = ">=3.13"`. CI now verifies exactly one version of each runtime, and the declared floor is that version (CONTRIBUTING.md §2), so Node 24 and Python 3.12 are no longer tested. Projects still on Node 24 or Python 3.12 should upgrade before taking this release.
