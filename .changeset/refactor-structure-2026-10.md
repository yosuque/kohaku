---
"@kohaku-ui/composer": patch
"@kohaku-ui/evals": patch
"@kohaku-ui/lineage": patch
"@kohaku-ui/cli": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host-mcp-apps": patch
"@kohaku-ui/storage-postgres": patch
"@kohaku-ui/storage-redis": patch
---

Internal, behavior-preserving refactoring of the composer tier ladder (budget gate, discriminated `TierResult`, L2 lint rule table), the evals judge (pure verdict aggregation), lineage (promotion import cycle, fixation guard/stamp helpers, candidate bulk loader, analytics accumulators), the CLI (shared lineage-source options, scaffold target table), both hosts (compose pipeline module, shared tool-call preamble, inline gate mapping) and the Postgres/Redis adapters (shared WHERE builder and record-table helper). No public API, wire format, persisted format or client-visible message changes.
