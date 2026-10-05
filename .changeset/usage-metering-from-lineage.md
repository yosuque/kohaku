---
"@kohaku-ui/lineage": patch
"@kohaku-ui/client": patch
"@kohaku-ui/admin-react": patch
"@kohaku-ui/cli": patch
---

Usage metering derived from lineage (design.md #74). `@kohaku-ui/lineage` adds the pure `summarizeUsage` (per-day, per-tenant rows: compositions, cache outcomes, tiers, L2 generations, fallbacks, LLM tokens from `view.composed`'s `decision.usage`, fixations) and `LineageSummary.usage`, so `GET /analytics/summary` gains a `summary.usage` array (additive; the wire is otherwise unchanged). `@kohaku-ui/client` types it as `UsageRowView`, and the admin Analytics tab shows a "Usage by day" table, labelled as a sample of the most recent events. `@kohaku-ui/cli` adds `kohaku usage export` (`--data-dir` or `--rest`, `--since` / `--until`, `--format csv|json`, `--out`), which pages the whole lineage log and writes a fixed-header CSV for metering. The host's in-process daily token ledger is not used for metering.
