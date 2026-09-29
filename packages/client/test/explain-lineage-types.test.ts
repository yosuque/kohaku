import type { ViewComposedPayload } from "@kohaku-ui/lineage";
import { describe, expect, it } from "vitest";
import type { ExplainDecision, ExplainDecisionAttempt, ExplainDecisionDowngrade } from "../src/index.js";

// The client keeps narrow local mirrors of lineage's view.composed `decision` wire shape (it must not depend on
// lineage at runtime). These compile-time assertions fail `pnpm typecheck` when lineage's shape drifts to
// something the client's explain types can no longer describe.

type LineageDecision = NonNullable<ViewComposedPayload["decision"]>;
type LineageAttempt = LineageDecision["attempts"][number];
type LineageDowngrade = NonNullable<LineageDecision["downgrades"]>[number];

type Assignable<From, To> = [From] extends [To] ? true : false;

const decisionAssignable: Assignable<LineageDecision, ExplainDecision> = true;
const attemptAssignable: Assignable<LineageAttempt, ExplainDecisionAttempt> = true;
const downgradeAssignable: Assignable<LineageDowngrade, ExplainDecisionDowngrade> = true;

describe("@kohaku-ui/client explain types stay assignable from lineage's decision summary", () => {
  it("is enforced at type level (see the assertions above)", () => {
    expect([decisionAssignable, attemptAssignable, downgradeAssignable]).toEqual([true, true, true]);
  });
});
