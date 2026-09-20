import { describe, expect, it } from "vitest";
import type { Lineage } from "../src/lineage.js";
import { recordFailOpen } from "../src/promotion/audit.js";
import type { PromotionErrorContext } from "../src/promotion/service.js";

/**
 * Unit coverage for the shared fail-open audit-record helper (H7), extracted out of the five call sites in
 * promotion/service.ts and promotion/nomination.ts. The five sites' own end-to-end fail-open behavior (and the
 * endpoint strings) stay covered by promotion-reconcile.test.ts and promotion-nominate.test.ts; this file only
 * pins the helper's own contract in isolation.
 */
describe("recordFailOpen", () => {
  it("lineage.record が拒否されたら onError が一度だけ { endpoint, artifactId, tenant } で呼ばれ、helper 自体は resolve する", async () => {
    const recordCalls: unknown[][] = [];
    const thrown = new Error("appendLineage failed (test)");
    const lineage: Pick<Lineage, "record"> = {
      record: async (...args) => {
        recordCalls.push(args);
        throw thrown;
      },
    };
    const errors: { ctx: PromotionErrorContext; error: unknown }[] = [];

    await expect(
      recordFailOpen(
        lineage,
        (ctx, error) => errors.push({ ctx, error }),
        "promotion.publish.audit",
        "component.published",
        { artifactId: "art-1", componentType: "sales.x", version: "1.0.0", intentName: "sales.x" },
        undefined,
        { tenant: "tenant-a", artifactId: "art-1" },
      ),
    ).resolves.toBeUndefined();

    expect(recordCalls).toEqual([
      [
        "component.published",
        { artifactId: "art-1", componentType: "sales.x", version: "1.0.0", intentName: "sales.x" },
        undefined,
        "tenant-a",
      ],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.ctx).toEqual({
      endpoint: "promotion.publish.audit",
      artifactId: "art-1",
      tenant: "tenant-a",
    });
    expect(errors[0]!.error).toBe(thrown);
  });

  it("scope.tenant が未指定なら onError の ctx に tenant キー自体が現れない", async () => {
    const lineage: Pick<Lineage, "record"> = {
      record: async () => {
        throw new Error("appendLineage failed (test)");
      },
    };
    const errors: PromotionErrorContext[] = [];

    await recordFailOpen(
      lineage,
      (ctx) => errors.push(ctx),
      "promotion.nominate.audit",
      "component.nominated",
      { artifactId: "art-2", by: "policy" },
      undefined,
      { artifactId: "art-2" },
    );

    expect(errors).toEqual([{ endpoint: "promotion.nominate.audit", artifactId: "art-2" }]);
    expect("tenant" in errors[0]!).toBe(false);
  });

  it("lineage.record が解決したら onError は呼ばれない", async () => {
    const lineage: Pick<Lineage, "record"> = {
      record: async () => ({}) as never,
    };
    const errors: unknown[] = [];

    await recordFailOpen(
      lineage,
      () => errors.push("called"),
      "promotion.unpublish.audit",
      "component.withdrawn",
      { artifactId: "art-3", from: "published", by: "user-1" },
      { kind: "user", id: "user-1" },
      { tenant: "tenant-b", artifactId: "art-3" },
    );

    expect(errors).toHaveLength(0);
  });

  it("onError が未指定でも lineage.record の失敗を吸収して resolve する", async () => {
    const lineage: Pick<Lineage, "record"> = {
      record: async () => {
        throw new Error("appendLineage failed (test)");
      },
    };

    await expect(
      recordFailOpen(
        lineage,
        undefined,
        "promotion.reconcile.audit",
        "component.published",
        { artifactId: "art-4" },
        undefined,
        { artifactId: "art-4" },
      ),
    ).resolves.toBeUndefined();
  });
});
