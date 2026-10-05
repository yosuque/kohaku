/**
 * The promotion statuses that still wait for someone to act (the Analytics tab's "pending promotions" card):
 * everything between a nomination and the schema proposal, i.e. every status that is neither `in_use` (not yet a
 * candidate) nor terminal (`published` / `rejected` / `withdrawn`).
 *
 * `PromotionCandidateView.status` is a plain `string` and `GET /promotions?status=` takes one status at a time,
 * so the list is held here and the count is taken client-side from one unfiltered list call. The statuses
 * themselves belong to `@kohaku-ui/lineage`'s `PromotionStatus` machine, which this package may not import;
 * `test/pending-statuses.test.ts` pins this list against that machine so a new status cannot slip by.
 */
export const PENDING_PROMOTION_STATUSES: readonly string[] = [
  "candidate",
  "judging",
  "judge_failed",
  "in_review",
  "changes_requested",
  "approved",
  "schema_proposed",
];
