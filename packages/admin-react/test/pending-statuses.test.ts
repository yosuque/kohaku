import { describe, expect, it } from "vitest";
// Reached by a relative path on purpose: `@kohaku-ui/lineage` is not (and must not become) a dependency of this
// package (see boundary.test.ts); this test is the one place that reads the promotion machine, so that the
// hand-held status list in src/pending-statuses.ts cannot silently fall behind it. machine.ts itself imports only
// spec-core.
import { isTerminal, type PromotionStatus } from "../../lineage/src/promotion/machine.js";
import { PENDING_PROMOTION_STATUSES } from "../src/pending-statuses.js";

// `Record<PromotionStatus, true>` is exhaustive: adding a status to the machine is a compile error here until it
// is listed, and the assertion below then decides whether it is pending.
const ALL_STATUSES: Record<PromotionStatus, true> = {
  in_use: true,
  candidate: true,
  judging: true,
  judge_failed: true,
  in_review: true,
  changes_requested: true,
  approved: true,
  schema_proposed: true,
  published: true,
  rejected: true,
  withdrawn: true,
};

describe("PENDING_PROMOTION_STATUSES", () => {
  it("is exactly the statuses that are neither in_use nor terminal in the promotion machine", () => {
    const expected = (Object.keys(ALL_STATUSES) as PromotionStatus[])
      .filter((status) => status !== "in_use" && !isTerminal(status))
      .sort();
    expect([...PENDING_PROMOTION_STATUSES].sort()).toEqual(expected);
    expect(PENDING_PROMOTION_STATUSES).toHaveLength(7);
  });
});
