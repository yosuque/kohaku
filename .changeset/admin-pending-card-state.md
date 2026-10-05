---
"@kohaku-ui/admin-react": patch
---

The Analytics tab's pending-promotions card now exposes whether its count is still loading, ready or unavailable (`data-state` on the card, and `status` on `usePendingPromotionCount()`), because the "—" it shows reads the same while loading and after a failed read.
