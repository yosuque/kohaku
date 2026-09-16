---
"@kohaku-ui/sandbox": patch
---

Fix `maxDomNodes` to bound currently-connected DOM nodes instead of the lifetime count of nodes ever created (so removing nodes frees budget for new ones instead of eventually stalling a long-lived widget), and escape generated CSS so it cannot close the trusted `<style>` element it is embedded in.
