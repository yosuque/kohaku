---
"@kohaku-ui/host-core": patch
---

`PolicyRuntime.reload` now awaits the `policy.applied` audit before committing the new policy, so a rejecting audit leaves the previous policy in force (as documented) and a retry with the same file records the event instead of being deduplicated away (design.md decision 69).
