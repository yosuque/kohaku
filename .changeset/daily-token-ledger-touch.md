---
"@kohaku-ui/host-core": patch
---

`DailyTokenLedger.spent()` now counts as an LRU touch (an over-budget tenant that is only read no longer gets evicted and has its budget reset), and the ledger docs state that it is in-process only, so `dailyTokens` applies per host instance.
