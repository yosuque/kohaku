# Security Policy

## Reporting a vulnerability

Please report suspected security vulnerabilities using GitHub's **Private
vulnerability reporting** (this repository's *Security* tab → *Report a
vulnerability*). Do not open a public issue for a suspected vulnerability.

We aim to send an initial response within **7 days** of a report. Timelines
for a fix depend on severity and complexity, and we'll keep you updated as we
work through it.

## Supported versions

kohaku is in a pre-release stage. Only the v0.1 line is supported; there is no
older line receiving security fixes.

## Scope

**In scope:**

- `packages/*` (all library packages)
- `cli/`
- `spec/`
- `python/kohaku` (the Python library)

**Out of scope:**

`apps/sample-*` and `python/examples/*` are demonstration sample
implementations, not production-hardened code, and are **out of scope** for
vulnerability reports. In particular:

- The MCP Streamable HTTP entry point (`start:http` / `sales_api.mcp_http`)
  is **intentionally unauthenticated** — it exists to make the demo easy to
  connect to from external chat clients, not to be exposed as a public
  service.
- The capability-token signing secret defaults to
  `KOHAKU_CAPABILITY_SECRET=dev-secret-change-me` in `.env.example`. This is a
  placeholder meant to be replaced, not a production default.
- `@kohaku-ui/storage-memory`'s reference `StoragePort` implementations
  (`createMemoryStoragePort`, and the file-backed `createFileStoragePort` in
  `packages/storage-memory/src/file-storage-port.ts`, which the sample uses)
  are single-process by design — no cross-process locking and no access
  control, documented as such in their own comments. Despite living in a
  `packages/*` package, this is a known, intentional limitation of a
  reference implementation meant to be replaced with a product's own
  `StoragePort` before production, not a vulnerability.

These are all deliberate, documented design choices: a product built on
kohaku is expected to supply its own `AuthzPort` / `StoragePort`
implementations (or a hardened deployment of the reference ones above), its
own signing secret, and its own network exposure and authentication in front
of any host endpoint. Findings that rely on the sample's demo defaults, or on
the documented single-process design of `storage-memory`'s reference
`StoragePort` implementations, rather than on an actual flaw in `packages/*`,
`cli/`, `spec/`, or `python/kohaku` themselves, are not actionable as
security reports, but you're welcome to raise them as regular issues if you
think the demo's
defaults should be hardened further.

## The sandbox boundary

`packages/sandbox` is the security boundary that confines L2 (free-form
generated) HTML to an iframe/Worker with no `document`/`window.open`/network
access and a restrictive CSP (see `spec/SPEC.md`'s `SBX-*` requirements). A
bypass of this boundary — generated content escaping the sandbox, reaching
the network, or acting on the host document — **is in scope** and should be
reported as above.

The L2 **smoke validation** path (`packages/sandbox/src/smoke`) is a
different thing: it runs inside the host process using Node's `node:vm` to
pre-validate generated script before delivery. It must only ever be used on
HTML from a trusted origin (i.e., the host's own composer output before it is
sandboxed for delivery) — it is **not** a security boundary and must never be
used to execute untrusted input.
