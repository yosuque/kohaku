import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { FixationRecord, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { PROMOTION_MIN_USES } from "../src/app/promotions.js";
import { createApp, FIXATION_MIN_USES } from "../src/app.js";

// M7 reconciliation test: sample-web's i18n copy ("candidates appear after N uses", ui.ts's
// admin.fixations.candidatesEmpty / admin.promotions.emptyAll) reads its threshold numbers from
// GET /analytics/summary's `promotionPolicy` rather than duplicating them as string literals. This guards
// that the response actually carries the same numbers app.ts wires into the real fixation/promotion policy
// objects (FIXATION_MIN_USES / PROMOTION_MIN_USES) — a drift here would silently desync the displayed copy
// from the server's actual nomination threshold.

function makeMemoryStorage() {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(key: string) {
      return cache.get(key) ?? null;
    },
    async putSpecCache(key: string, spec: UISpec) {
      cache.set(key, spec);
    },
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation(): Promise<FixationRecord | null> {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

async function makeTestApp() {
  return createApp({
    llm: new FakeLlm({ objects: [] }),
    storage: makeMemoryStorage(),
    authz: createHmacAuthzPort("test-secret"),
  });
}

describe("GET /api/kohaku/analytics/summary bundles the nomination thresholds", () => {
  it("carries promotionPolicy matching the exported FIXATION_MIN_USES / PROMOTION_MIN_USES constants", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("/api/kohaku/analytics/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promotionPolicy?: { fixationMinUses: number; promotionMinUses: number };
    };
    expect(body.promotionPolicy).toEqual({
      fixationMinUses: FIXATION_MIN_USES,
      promotionMinUses: PROMOTION_MIN_USES,
    });
  });

  it("does not rewrite a denied (non-2xx) response", async () => {
    const { app } = await makeTestApp();
    // viewer/reviewer both have analytics.read (see host-deps.ts's RBAC matrix), so simulate a deny by
    // requesting with a role that authorizeGovernance rejects for every governance kind (unknown role).
    const res = await app.request("/api/kohaku/analytics/summary", {
      headers: { "x-kohaku-role": "unknown-role" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { promotionPolicy?: unknown };
    expect(body.promotionPolicy).toBeUndefined();
  });
});
