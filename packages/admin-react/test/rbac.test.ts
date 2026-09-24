import { KohakuHostError } from "@kohaku-ui/client";
import { describe, expect, it } from "vitest";
import { defaultAdminMessages, describeDeniedOperation } from "../src/index.js";

describe("describeDeniedOperation", () => {
  it("explains a 403 CAPABILITY_DENIED with the role message", () => {
    // KohakuHostError's constructor is (code, message, status, requestId?, promotionStatus?) — see
    // packages/client/src/errors.ts.
    const denied = new KohakuHostError("CAPABILITY_DENIED", "nope", 403);
    expect(describeDeniedOperation(denied, "approving a promotion", defaultAdminMessages)).toBe(
      defaultAdminMessages.deniedMessage("CAPABILITY_DENIED", "approving a promotion"),
    );
  });

  it("explains a 401 with the auth-required message, even though sample-api reuses CAPABILITY_DENIED as the code", () => {
    // status is the authoritative signal here, not code: sample-api's JWT profile returns 401 for a
    // missing/invalid token using the SAME `CAPABILITY_DENIED` code as an ordinary 403 role denial (see Task
    // 7's review) — describeDeniedOperation must still tell them apart and never show the role-switch copy
    // for what is actually a "you are not signed in" problem.
    const unauthorized = new KohakuHostError("CAPABILITY_DENIED", "no session", 401);
    expect(describeDeniedOperation(unauthorized, "approving a promotion", defaultAdminMessages)).toBe(
      defaultAdminMessages.authRequiredMessage("CAPABILITY_DENIED", "approving a promotion"),
    );
  });

  it("returns null for anything else (falls through to a generic failure notice)", () => {
    const other = new KohakuHostError("PROMOTION_INVALID", "nope", 422);
    expect(describeDeniedOperation(other, "approving a promotion", defaultAdminMessages)).toBeNull();
  });
});
