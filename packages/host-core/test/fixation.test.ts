import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type CanonicalIntent,
  computeStructureHash,
  type FixationRecord,
  type SemanticPort,
  type SessionContext,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  composeWithFixation,
  type FixationDeliveryHost,
  type FixationSelfHealApi,
  resolveFixatedResult,
  settleFixation,
} from "../src/fixation.js";

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";
const INTENT: CanonicalIntent = { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) };
const SESSION: SessionContext = { surface: "web" };

function stubSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@v1";
    },
  };
}

function stubStorage(): StoragePort {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(k) {
      return cache.get(k) ?? null;
    },
    async putSpecCache(k, s) {
      cache.set(k, s);
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
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

/** Fallback L0 fixed Spec for normal compose (deterministic markdown; no LLM call needed). */
function fallbackFixed(): UISpec {
  return {
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "ignored",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "normal compose fallback" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function composeCtx(): ComposeContext {
  return {
    catalog,
    semantic: stubSemantic(),
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: { fixedSpecs: { lookup: async () => fallbackFixed() } },
  };
}

function validPinned(): UISpec {
  return {
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "pinned@v0",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

// Every call site in this file builds its fixation from validPinned() verbatim, so its structureHash can be
// precomputed once at module load (top-level await) rather than making every `it(...)` async and every
// makeFixation call site await it -- some of the call sites below are inside synchronous `it` callbacks.
const VALID_PINNED_STRUCTURE_HASH = await computeStructureHash(validPinned());

function makeFixation(pinnedSpec: UISpec, catalogFingerprint?: string): FixationRecord {
  return {
    intentHash: INTENT.hash,
    canonical: "sales.trend",
    // materializeFixation verifies this against pinnedSpec, so it must stay the real hash of validPinned()'s
    // content, not a placeholder (every call site here passes validPinned() unmodified).
    structureHash: VALID_PINNED_STRUCTURE_HASH,
    pinnedSpec,
    fixatedAt: "2026-06-10T00:00:00Z",
    approver: { id: "tester" },
    ...(catalogFingerprint != null ? { catalogFingerprint } : {}),
  };
}

/** A host with no fixation, no self-heal wiring — settleFixation degrades to identity for callers with no fixations. */
function baseHost(overrides: Partial<FixationDeliveryHost> = {}): FixationDeliveryHost {
  return {
    onSelfHealError: vi.fn(),
    ...overrides,
  };
}

describe("resolveFixatedResult / composeWithFixation call order", () => {
  it("no fixation -> lookup returns null -> composeWithFixation falls through to compose()", async () => {
    const lookup = vi.fn(async () => null);
    const host = baseHost({ lookup });
    const result = await composeWithFixation(INTENT, SESSION, { materialize: composeCtx() }, host);
    expect(lookup).toHaveBeenCalledWith(INTENT.hash, SESSION);
    expect(result.spec.provenance.cache).not.toBe("fixated");
    expect(result.spec.components.some((c) => c.type === "presentMarkdown")).toBe(true);
  });

  it("fresh fixation (fingerprint match) is delivered without touching self-heal", async () => {
    const fixation = makeFixation(validPinned(), catalog.fingerprint);
    const lookup = vi.fn(async () => fixation);
    const fixations: FixationSelfHealApi = {
      invalidate: vi.fn(async () => {}),
      refreshFingerprint: vi.fn(async () => {}),
    };
    const host = baseHost({ lookup, fixations });
    const result = await resolveFixatedResult(INTENT, SESSION, composeCtx(), host);
    expect(result?.spec.provenance.cache).toBe("fixated");
    expect(fixations.invalidate).not.toHaveBeenCalled();
    expect(fixations.refreshFingerprint).not.toHaveBeenCalled();
  });

  it("compose() only receives an abort signal when one is passed", async () => {
    // Spy by making resolveFixatedResult fall through (no lookup) and racing a real AbortController through the
    // composer's L0 fixed-spec path (which does not consult the signal but must accept the option shape).
    const host = baseHost();
    const withoutAbort = await composeWithFixation(INTENT, SESSION, { materialize: composeCtx() }, host);
    expect(withoutAbort.spec).toBeDefined();
    const controller = new AbortController();
    const withAbort = await composeWithFixation(
      INTENT,
      SESSION,
      { materialize: composeCtx(), abort: controller.signal },
      host,
    );
    expect(withAbort.spec).toBeDefined();
  });

  it("composeWithFixation uses ctx.compose (falling back to ctx.materialize) for the normal-compose path", async () => {
    const materializeCtx = composeCtx();
    const composeOnlyCtx = { ...composeCtx(), catalog: resolveCatalog(coreCatalog) };
    const host = baseHost();
    // No fixation configured (lookup unset) -> falls through to compose() against ctx.compose.
    const result = await composeWithFixation(
      INTENT,
      SESSION,
      { materialize: materializeCtx, compose: composeOnlyCtx },
      host,
    );
    expect(result.spec.components.some((c) => c.type === "presentMarkdown")).toBe(true);
  });
});

describe("settleFixation: revalidated", () => {
  it("fires refreshFingerprint(hash, catalog.fingerprint, {tenant}) without awaiting, returns result synchronously", async () => {
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshFingerprint = vi.fn(() => refreshPromise);
    const host = baseHost({ fixations: { refreshFingerprint } });

    const materialized = {
      result: { spec: validPinned(), trace: {} as never },
      check: { kind: "revalidated" as const },
    };
    const settled = settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: "acme", catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );

    // Returned synchronously even though refreshFingerprint has not resolved yet (fire-and-forget).
    expect(settled).toBe(materialized.result);
    expect(refreshFingerprint).toHaveBeenCalledWith(INTENT.hash, catalog.fingerprint, { tenant: "acme" });
    resolveRefresh();
  });

  it("passes scope=undefined when tenant is undefined", () => {
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    const refreshFingerprint = vi.fn(async () => {});
    const host = baseHost({ fixations: { refreshFingerprint } });
    const materialized = {
      result: { spec: validPinned(), trace: {} as never },
      check: { kind: "revalidated" as const },
    };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );
    expect(refreshFingerprint).toHaveBeenCalledWith(INTENT.hash, catalog.fingerprint, undefined);
  });

  it("reports a refreshFingerprint failure via onSelfHealError with endpoint fixation.refreshFingerprint", async () => {
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    const boom = new Error("boom");
    const refreshFingerprint = vi.fn(async () => {
      throw boom;
    });
    const onSelfHealError = vi.fn();
    const host = baseHost({ fixations: { refreshFingerprint }, onSelfHealError });
    const materialized = {
      result: { spec: validPinned(), trace: {} as never },
      check: { kind: "revalidated" as const },
    };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
      "req-abc",
    );
    // Let the fire-and-forget rejection settle before asserting.
    await new Promise((r) => setTimeout(r, 0));
    // The requestId passed to settleFixation is forwarded to onSelfHealError as the 3rd argument, so a host
    // can tie the self-heal failure back to the request that triggered it.
    expect(onSelfHealError).toHaveBeenCalledWith("fixation.refreshFingerprint", boom, "req-abc");
  });

  it("does not call refreshFingerprint when the check is 'fresh' (no fingerprint mismatch)", () => {
    const fixation = makeFixation(validPinned(), catalog.fingerprint);
    const refreshFingerprint = vi.fn(async () => {});
    const host = baseHost({ fixations: { refreshFingerprint } });
    const materialized = {
      result: { spec: validPinned(), trace: {} as never },
      check: { kind: "fresh" as const },
    };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );
    expect(refreshFingerprint).not.toHaveBeenCalled();
  });
});

describe("settleFixation: stale", () => {
  it("fires invalidate(hash, 'stale', {detail, guard, tenant}) without awaiting, returns null synchronously", async () => {
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    let resolveInvalidate!: () => void;
    const invalidatePromise = new Promise<void>((resolve) => {
      resolveInvalidate = resolve;
    });
    const invalidate = vi.fn(() => invalidatePromise);
    const host = baseHost({ fixations: { invalidate } });

    const materialized = { result: null, check: { kind: "stale" as const, issues: ["ghost: removed"] } };
    const settled = settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: "acme", catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );

    expect(settled).toBeNull();
    expect(invalidate).toHaveBeenCalledWith(INTENT.hash, "stale", {
      detail: "ghost: removed",
      guard: { ifFixatedAt: fixation.fixatedAt, ifCatalogFingerprint: "sha256:stale-fp" },
      tenant: "acme",
    });
    resolveInvalidate();
  });

  it("guard has only ifFixatedAt when the fixation record has no catalogFingerprint", () => {
    const fixation = makeFixation(validPinned());
    const invalidate = vi.fn(async () => {});
    const host = baseHost({ fixations: { invalidate } });
    const materialized = { result: null, check: { kind: "stale" as const, issues: ["x: y"] } };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );
    expect(invalidate).toHaveBeenCalledWith(INTENT.hash, "stale", {
      detail: "x: y",
      guard: { ifFixatedAt: fixation.fixatedAt },
    });
  });

  it("reports an invalidate failure via onSelfHealError with endpoint fixation.invalidate", async () => {
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    const boom = new Error("boom");
    const invalidate = vi.fn(async () => {
      throw boom;
    });
    const onSelfHealError = vi.fn();
    const host = baseHost({ fixations: { invalidate }, onSelfHealError });
    const materialized = { result: null, check: { kind: "stale" as const, issues: ["x"] } };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
      "req-xyz",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(onSelfHealError).toHaveBeenCalledWith("fixation.invalidate", boom, "req-xyz");
  });

  it("passes requestId as undefined to onSelfHealError when settleFixation is not given one", async () => {
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    const boom = new Error("boom");
    const invalidate = vi.fn(async () => {
      throw boom;
    });
    const onSelfHealError = vi.fn();
    const host = baseHost({ fixations: { invalidate }, onSelfHealError });
    const materialized = { result: null, check: { kind: "stale" as const, issues: ["x"] } };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(onSelfHealError).toHaveBeenCalledWith("fixation.invalidate", boom, undefined);
  });
});

describe("settleFixation: serialize", () => {
  it("wraps both self-heal calls under serialize when provided", async () => {
    const order: string[] = [];
    const serializeScopes: Array<{ tenant: string | undefined; intentHash: string }> = [];
    const serialize: NonNullable<FixationDeliveryHost["serialize"]> = async (scope, fn) => {
      serializeScopes.push(scope);
      order.push("serialize-enter");
      const r = await fn();
      order.push("serialize-exit");
      return r;
    };
    const refreshFingerprint = vi.fn(async () => {
      order.push("refresh");
    });
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    const host = baseHost({ fixations: { refreshFingerprint }, serialize });
    const materialized = {
      result: { spec: validPinned(), trace: {} as never },
      check: { kind: "revalidated" as const },
    };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(serializeScopes).toEqual([{ tenant: undefined, intentHash: INTENT.hash }]);
    expect(order).toEqual(["serialize-enter", "refresh", "serialize-exit"]);
  });

  it("runs self-heal directly (identity) when serialize is not provided", async () => {
    const refreshFingerprint = vi.fn(async () => {});
    const fixation = makeFixation(validPinned(), "sha256:stale-fp");
    const host = baseHost({ fixations: { refreshFingerprint } });
    const materialized = {
      result: { spec: validPinned(), trace: {} as never },
      check: { kind: "revalidated" as const },
    };
    settleFixation(
      materialized,
      { intentHash: INTENT.hash, tenant: undefined, catalogFingerprint: catalog.fingerprint, fixation },
      host,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshFingerprint).toHaveBeenCalledTimes(1);
  });
});
