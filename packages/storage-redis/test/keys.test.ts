import { describe, expect, it } from "vitest";
import { redisKeys, tenantSegment } from "../src/keys.js";

describe("tenantSegment", () => {
  it("maps a missing / empty tenant to the neutral marker", () => {
    expect(tenantSegment(undefined)).toBe("%");
    expect(tenantSegment("")).toBe("%");
  });
  it("percent-encodes a tenant so ':' and '%' cannot collide with the layout or the marker", () => {
    expect(tenantSegment("acme:eu")).toBe("acme%3Aeu");
    expect(tenantSegment("%")).toBe("%25");
  });
});

describe("redisKeys", () => {
  const keys = redisKeys();
  it("uses the default prefix", () => {
    expect(keys.spec("k1")).toBe("kohaku:spec:k1");
    expect(keys.lineage.events).toBe("kohaku:lineage:events");
    expect(keys.lineage.index("type", "view.composed")).toBe("kohaku:lineage:idx:type:view.composed");
  });
  it("keys promotion / fixation by (tenant, id) with tenant-neutral and per-tenant indexes", () => {
    expect(keys.promotion("acme", "a1")).toBe("kohaku:acme:promotion:a1");
    expect(keys.promotion(undefined, "a1")).toBe("kohaku:%:promotion:a1");
    expect(keys.promotionIndex("acme")).toBe("kohaku:acme:promotion:index");
    expect(keys.promotionIndex(undefined)).toBe("kohaku:promotion:index");
    expect(keys.fixation("acme", "sha256:ab")).toBe("kohaku:acme:fixation:sha256:ab");
    expect(keys.fixationIndex(undefined)).toBe("kohaku:fixation:index");
  });
  it("honours a custom prefix", () => {
    expect(redisKeys("app1").spec("k")).toBe("app1:spec:k");
  });
});
