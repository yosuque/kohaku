import type { Principal } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { governancePolicyFromRoles } from "../src/index.js";

function principal(...roles: string[]): Principal {
  return { id: `u-${roles.join("-")}`, roles };
}

describe("governancePolicyFromRoles", () => {
  it("evaluates using the roles rolesFor(tenant) returns for that tenant", () => {
    const evaluate = governancePolicyFromRoles(
      (tenant): Record<string, readonly string[]> =>
        tenant === "tenant-a" ? { admin: ["*"] } : { viewer: ["lineage.read"] },
    );
    expect(evaluate(principal("admin"), { kind: "promotion.approve" }, "tenant-a")).toBe(true);
    // Same principal/operation, different tenant -> different roles map -> denied.
    expect(evaluate(principal("admin"), { kind: "promotion.approve" }, "tenant-b")).toBe(false);
  });

  it("re-resolves rolesFor on every call (reflects a live reload, not a snapshot)", () => {
    let roles: Record<string, readonly string[]> = { viewer: ["lineage.read"] };
    const evaluate = governancePolicyFromRoles(() => roles);

    expect(evaluate(principal("viewer"), { kind: "promotion.approve" })).toBe(false);
    roles = { viewer: ["*"] };
    expect(evaluate(principal("viewer"), { kind: "promotion.approve" })).toBe(true);
  });

  it("denies by default: an unknown role or an empty roles map matches nothing", () => {
    const evaluate = governancePolicyFromRoles(() => ({}));
    expect(evaluate(principal("admin"), { kind: "lineage.read" })).toBe(false);
  });

  it("supports domain wildcards (<domain>.*) the same way createGovernancePolicy does", () => {
    const evaluate = governancePolicyFromRoles(() => ({ reviewer: ["promotion.*"] }));
    expect(evaluate(principal("reviewer"), { kind: "promotion.approve" })).toBe(true);
    expect(evaluate(principal("reviewer"), { kind: "fixation.remove" })).toBe(false);
  });

  it("a role union across multiple roles is allowed if any matches", () => {
    const evaluate = governancePolicyFromRoles(() => ({
      viewer: ["lineage.read"],
      approver: ["promotion.approve"],
    }));
    expect(evaluate(principal("viewer", "approver"), { kind: "promotion.approve" })).toBe(true);
  });
});
