import type { ComposePolicy } from "@kohaku-ui/composer";
import type { KohakuPolicyFile, RateLimitStore } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createDailyTokenLedger } from "../src/daily-token-ledger.js";
import { createPolicyRuntime, type PolicyAppliedEvent, parsePolicy } from "../src/policy.js";
import { DEFAULT_MAX_MEMORY_ENTRIES } from "../src/rate-limit.js";

function makeFile(overrides: Partial<KohakuPolicyFile> = {}): KohakuPolicyFile {
  return { version: 1, defaults: {}, ...overrides };
}

describe("parsePolicy", () => {
  it("validates and computes a policyId for well-formed input", async () => {
    const parsed = await parsePolicy({ version: 1, defaults: { compose: { allowL2: true } } });
    expect(parsed.file.defaults.compose?.allowL2).toBe(true);
    expect(parsed.policyId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws on invalid input (unknown key)", async () => {
    await expect(parsePolicy({ version: 1, defaults: {}, bogus: true })).rejects.toThrow();
  });
});

describe("createPolicyRuntime: policyFor", () => {
  it("layers the policy file's compose section onto the base policy, keeping the base's function-shaped fields", async () => {
    const routeTier = () => "L2" as const;
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { allowL2: true, outputLanguage: "Japanese" } } }),
      basePolicyFor: () => ({ routeTier }),
    });
    const policy = runtime.policyFor();
    expect(policy.allowL2).toBe(true);
    expect(policy.outputLanguage).toBe("Japanese");
    expect(policy.routeTier).toBe(routeTier); // untouched function-shaped field
  });

  it("a tenant's section overrides defaults for that tenant only", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile({
        defaults: { compose: { allowL2: true } },
        tenants: { "tenant-a": { compose: { allowL2: false } } },
      }),
    });
    expect(runtime.policyFor({ surface: "web", tenant: "tenant-a" }).allowL2).toBe(false);
    expect(runtime.policyFor({ surface: "web", tenant: "tenant-b" }).allowL2).toBe(true);
    expect(runtime.policyFor().allowL2).toBe(true); // no tenant = defaults
  });

  it("a data field the policy file never sets falls back to the base policy's own value", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile(),
      basePolicyFor: () => ({ allowL2: true, maxRepairAttempts: 3 }),
    });
    const policy = runtime.policyFor();
    expect(policy.allowL2).toBe(true);
    expect(policy.maxRepairAttempts).toBe(3);
  });

  it("is memoized per (tenant, base policy object): the same inputs return the identical object", async () => {
    const base: ComposePolicy = { allowL2: true };
    const runtime = await createPolicyRuntime({ file: makeFile(), basePolicyFor: () => base });
    const first = runtime.policyFor({ surface: "web", tenant: "t1" });
    const second = runtime.policyFor({ surface: "web", tenant: "t1" });
    expect(second).toBe(first);
  });

  it("recomputes when basePolicyFor returns a different object for the same tenant", async () => {
    let base: ComposePolicy = { allowL2: true };
    const runtime = await createPolicyRuntime({ file: makeFile(), basePolicyFor: () => base });
    const first = runtime.policyFor();
    base = { allowL2: true }; // a new object, same shape
    const second = runtime.policyFor();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("recomputes after reload even if basePolicyFor keeps returning the same object", async () => {
    const base: ComposePolicy = {};
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { allowL2: false } } }),
      basePolicyFor: () => base,
    });
    const before = runtime.policyFor();
    expect(before.allowL2).toBe(false);
    await runtime.reload(makeFile({ defaults: { compose: { allowL2: true } } }));
    const after = runtime.policyFor();
    expect(after).not.toBe(before);
    expect(after.allowL2).toBe(true);
  });
});

describe("createPolicyRuntime: budget (perCompose/deadlineMs/dailyTokens)", () => {
  it("perCompose/deadlineMs from the policy file override the base policy's own", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile({
        defaults: { compose: { budget: { perCompose: { stopAfterTokens: 10 }, deadlineMs: 5000 } } },
      }),
      basePolicyFor: () => ({ budget: { perCompose: { stopAfterTokens: 999 }, deadlineMs: 999 } }),
    });
    const budget = runtime.policyFor().budget;
    expect(budget?.perCompose).toEqual({ stopAfterTokens: 10 });
    expect(budget?.deadlineMs).toBe(5000);
  });

  it("perCompose/deadlineMs fall back to the base policy's own when the file leaves budget unset", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile(),
      basePolicyFor: () => ({ budget: { perCompose: { stopAfterTokens: 999 }, deadlineMs: 999 } }),
    });
    const budget = runtime.policyFor().budget;
    expect(budget?.perCompose).toEqual({ stopAfterTokens: 999 });
    expect(budget?.deadlineMs).toBe(999);
  });

  it("dailyTokens denies once the ledger's spent total for the tenant reaches the threshold", async () => {
    const ledger = createDailyTokenLedger(() => 0);
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { budget: { dailyTokens: 100 } } } }),
      ledger,
    });
    const check = runtime.policyFor({ surface: "web", tenant: "t1" }).budget?.check;
    expect(check).toBeDefined();
    expect(check?.()).toEqual({ allow: true });
    ledger.record("t1", 100);
    const verdict = check?.();
    expect(verdict?.allow).toBe(false);
    expect(verdict?.reason).toMatch(/daily token threshold/i);
  });

  it("dailyTokens is scoped per tenant (t1 exceeding does not affect t2)", async () => {
    const ledger = createDailyTokenLedger(() => 0);
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { budget: { dailyTokens: 10 } } } }),
      ledger,
    });
    ledger.record("t1", 10);
    expect(runtime.policyFor({ surface: "web", tenant: "t1" }).budget?.check?.().allow).toBe(false);
    expect(runtime.policyFor({ surface: "web", tenant: "t2" }).budget?.check?.().allow).toBe(true);
  });

  it("onUsage records into the ledger, combined with (not replacing) the base policy's own onUsage", async () => {
    const ledger = createDailyTokenLedger(() => 0);
    const baseCalls: unknown[] = [];
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { budget: { dailyTokens: 1000 } } } }),
      basePolicyFor: () => ({ budget: { onUsage: (info) => void baseCalls.push(info) } }),
      ledger,
    });
    const onUsage = runtime.policyFor({ surface: "web", tenant: "t1" }).budget?.onUsage;
    await onUsage?.({ tenant: "t1", usage: { inputTokens: 3, outputTokens: 4 } });
    expect(baseCalls).toHaveLength(1);
    expect(ledger.spent("t1")).toBe(7);
  });

  it("dailyTokens is a soft limit: N in-flight composes can all pass check() before any of them records, overshooting by up to N x the per-compose ceiling (design.md #69 -- check() must stay side-effect-free, so it cannot reserve a slice of the budget)", async () => {
    const ledger = createDailyTokenLedger(() => 0);
    const stopAfterTokens = 1000;
    const runtime = await createPolicyRuntime({
      file: makeFile({
        defaults: { compose: { budget: { dailyTokens: 1, perCompose: { stopAfterTokens } } } },
      }),
      ledger,
    });
    const budget = runtime.policyFor({ surface: "web", tenant: "t1" }).budget;
    const concurrentGenerations = 3;

    // All N in-flight generations call check() while the ledger still reads 0 spent -- none of
    // them has recorded usage yet, so every one of them is allowed, even though a single dailyTokens
    // threshold of 1 would deny every generation after the very first if they ran one at a time.
    const verdicts = Array.from({ length: concurrentGenerations }, () => budget?.check?.());
    expect(verdicts.every((v) => v?.allow === true)).toBe(true);

    // Only once each "completes" does onUsage record -- up to the per-compose ceiling each.
    for (let i = 0; i < concurrentGenerations; i++) {
      await budget?.onUsage?.({ tenant: "t1", usage: { inputTokens: stopAfterTokens, outputTokens: 0 } });
    }

    const overshoot = ledger.spent("t1") - 1; // dailyTokens threshold was 1
    expect(overshoot).toBeGreaterThan(0);
    expect(overshoot).toBeLessThanOrEqual(concurrentGenerations * stopAfterTokens);
  });

  it("a base check's denial wins outright over the dailyTokens check (combineChecks short-circuits)", async () => {
    const ledger = createDailyTokenLedger(() => 0); // way under the 1,000,000 threshold below
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { budget: { dailyTokens: 1_000_000 } } } }),
      basePolicyFor: () => ({
        budget: { check: () => ({ allow: false, reason: "base says no" }) },
      }),
      ledger,
    });
    const verdict = runtime.policyFor({ surface: "web", tenant: "t1" }).budget?.check?.();
    expect(verdict).toEqual({ allow: false, reason: "base says no" });
  });

  it("budget is left unset when neither the file nor the base policy set anything", async () => {
    const runtime = await createPolicyRuntime({ file: makeFile() });
    expect(runtime.policyFor().budget).toBeUndefined();
  });
});

describe("createPolicyRuntime: rolesFor", () => {
  it("merges defaults and the tenant's own roles", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile({
        defaults: { governance: { roles: { admin: ["*"] } } },
        tenants: { "tenant-a": { governance: { roles: { viewer: ["lineage.read"] } } } },
      }),
    });
    expect(runtime.rolesFor("tenant-a")).toEqual({ admin: ["*"], viewer: ["lineage.read"] });
    expect(runtime.rolesFor("tenant-b")).toEqual({ admin: ["*"] });
  });

  it("is {} when neither defaults nor the tenant declare governance", async () => {
    const runtime = await createPolicyRuntime({ file: makeFile() });
    expect(runtime.rolesFor()).toEqual({});
  });
});

describe("createPolicyRuntime: rateLimiter", () => {
  it("always allows when no RateLimitStore is supplied and the file declares no rateLimits", async () => {
    const runtime = await createPolicyRuntime({ file: makeFile() });
    expect(await runtime.rateLimiter.take({ routeClass: "compose" })).toEqual({ allow: true });
  });

  it("always allows when the routeClass has no configured rule", async () => {
    const store: RateLimitStore = { take: async () => ({ allow: false }) };
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { rateLimits: { compose: { capacity: 1, refillPerSecond: 1 } } } }),
      rateLimitStore: store,
    });
    expect(await runtime.rateLimiter.take({ routeClass: "action" })).toEqual({ allow: true });
  });

  it("enforces the tenant's effective rule via the store, keyed by tenant/principal/routeClass", async () => {
    const calls: unknown[] = [];
    const store: RateLimitStore = {
      take: async (key, cost, rule, nowMs) => {
        calls.push({ key, cost, rule, nowMs });
        return { allow: true };
      },
    };
    const runtime = await createPolicyRuntime({
      file: makeFile({
        defaults: { rateLimits: { compose: { capacity: 5, refillPerSecond: 1 } } },
        tenants: { "tenant-a": { rateLimits: { compose: { capacity: 1, refillPerSecond: 2 } } } },
      }),
      rateLimitStore: store,
    });
    await runtime.rateLimiter.take({ tenant: "tenant-a", principal: "p1", routeClass: "compose" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      key: JSON.stringify(["tenant-a", "p1", "compose"]),
      rule: { capacity: 1, refillPerSecond: 2 },
    });
  });

  it("onRateLimitError is wired through to createRateLimiter: a throwing store still allows the request, and the hook is called", async () => {
    const errors: unknown[] = [];
    const store: RateLimitStore = {
      take: async () => {
        throw new Error("store outage");
      },
    };
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { rateLimits: { compose: { capacity: 1, refillPerSecond: 1 } } } }),
      rateLimitStore: store,
      onRateLimitError: (info) => void errors.push(info),
    });
    const result = await runtime.rateLimiter.take({ tenant: "t1", principal: "p1", routeClass: "compose" });
    expect(result).toEqual({ allow: true }); // fail-open
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ tenant: "t1", principal: "p1", routeClass: "compose" });
  });
});

describe("createPolicyRuntime: reload", () => {
  it("is a no-op (no audit call) when the new file has the same canonical content", async () => {
    const events: PolicyAppliedEvent[] = [];
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { allowL2: true } } }),
      audit: (e) => void events.push(e),
    });
    events.length = 0; // drop the startup event
    await runtime.reload(makeFile({ defaults: { compose: { allowL2: true } } }));
    expect(events).toHaveLength(0);
  });

  it("a same-content reload keeps the memoized policyFor result (the memo is cleared only on an effective change)", async () => {
    const base: ComposePolicy = {};
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { allowL2: true } } }),
      basePolicyFor: () => base,
    });
    const before = runtime.policyFor();
    await runtime.reload(makeFile({ defaults: { compose: { allowL2: true } } }));
    expect(runtime.policyFor()).toBe(before);
  });

  it("a rejecting audit leaves the previous policy in force, and a retry with the same file records the event", async () => {
    const events: PolicyAppliedEvent[] = [];
    let failNext = false;
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { allowL2: false } } }),
      audit: (e) => {
        if (failNext) throw new Error("lineage down");
        events.push(e);
      },
    });
    const before = runtime.policyId;
    const next = makeFile({ defaults: { compose: { allowL2: true } } });
    failNext = true;
    await expect(runtime.reload(next)).rejects.toThrow("lineage down");
    expect(runtime.policyId).toBe(before);
    expect(runtime.policyFor().allowL2).not.toBe(true);
    failNext = false;
    events.length = 0;
    await runtime.reload(next); // not deduped: the failed attempt never committed
    expect(runtime.policyId).not.toBe(before);
    expect(events).toHaveLength(1);
    expect(events[0]!.previousPolicyId).toBe(before);
  });

  it("fires audit with the new/previous policyId, version, label, changedPaths, and tenants", async () => {
    const events: Array<{ event: PolicyAppliedEvent; actor: string | undefined }> = [];
    const runtime = await createPolicyRuntime({
      file: makeFile({ label: "v1", defaults: { compose: { allowL2: false } } }),
      audit: (event, actor) => void events.push({ event, actor }),
    });
    const previousPolicyId = runtime.policyId;
    events.length = 0; // drop the startup event

    await runtime.reload(
      makeFile({
        label: "v2",
        defaults: { compose: { allowL2: true } },
        tenants: { "tenant-a": { compose: { allowL2: false } } },
      }),
      "alice",
    );

    expect(events).toHaveLength(1);
    const { event, actor } = events[0]!;
    expect(actor).toBe("alice");
    expect(event.previousPolicyId).toBe(previousPolicyId);
    expect(event.policyId).toBe(runtime.policyId);
    expect(event.policyId).not.toBe(previousPolicyId);
    expect(event.version).toBe(1);
    expect(event.label).toBe("v2");
    expect(event.tenants).toEqual(["tenant-a"]);
    expect(event.changedPaths.sort()).toEqual(["label", "defaults.compose.allowL2", "tenants"].sort());
  });

  it("policyId reflects the current file (live getter)", async () => {
    const runtime = await createPolicyRuntime({ file: makeFile() });
    const before = runtime.policyId;
    await runtime.reload(makeFile({ label: "changed" }));
    expect(runtime.policyId).not.toBe(before);
  });

  it("the first reload's previousPolicyId is the constructor file's policyId, not undefined", async () => {
    const events: PolicyAppliedEvent[] = [];
    const runtime = await createPolicyRuntime({
      file: makeFile(),
      audit: (e) => void events.push(e),
    });
    const initialPolicyId = runtime.policyId;
    events.length = 0; // drop the startup event
    await runtime.reload(makeFile({ label: "new" }));
    expect(events[0]?.previousPolicyId).toBe(initialPolicyId);
  });

  it("rejects a file declaring dailyTokens / rateLimits the runtime cannot enforce, keeping the previous policy", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { compose: { allowL2: false } } }),
    });
    const before = runtime.policyId;
    await expect(
      runtime.reload(makeFile({ defaults: { compose: { budget: { dailyTokens: 10 } } } })),
    ).rejects.toThrow(/dailyTokens.*ledger/);
    await expect(
      runtime.reload(
        makeFile({
          defaults: {},
          tenants: { "tenant-a": { rateLimits: { compose: { capacity: 1, refillPerSecond: 1 } } } },
        }),
      ),
    ).rejects.toThrow(/tenants\.tenant-a\.rateLimits.*rateLimitStore/);
    expect(runtime.policyId).toBe(before);
    expect(runtime.policyFor().allowL2).toBe(false);
  });
});

describe("createPolicyRuntime: startup audit", () => {
  it("fires audit once for the starting file, with no previousPolicyId and no actor", async () => {
    const calls: Array<{ event: PolicyAppliedEvent; actor: string | undefined }> = [];
    const runtime = await createPolicyRuntime({
      file: makeFile({ label: "boot", tenants: { "tenant-a": {} } }),
      audit: (event, actor) => void calls.push({ event, actor }),
    });
    expect(calls).toHaveLength(1);
    const { event, actor } = calls[0]!;
    expect(actor).toBeUndefined();
    expect(event.previousPolicyId).toBeUndefined();
    expect(event.policyId).toBe(runtime.policyId);
    expect(event.label).toBe("boot");
    expect(event.tenants).toEqual(["tenant-a"]);
    expect(event.changedPaths).toEqual(expect.arrayContaining(["version", "label", "defaults", "tenants"]));
  });

  it("works without an audit callback", async () => {
    await expect(createPolicyRuntime({ file: makeFile() })).resolves.toBeDefined();
  });
});

describe("createPolicyRuntime: declared dependencies", () => {
  it("throws when defaults declare dailyTokens but no ledger is supplied", async () => {
    await expect(
      createPolicyRuntime({ file: makeFile({ defaults: { compose: { budget: { dailyTokens: 5 } } } }) }),
    ).rejects.toThrow(/defaults\.compose\.budget\.dailyTokens.*ledger/);
  });

  it("throws when a tenant section declares dailyTokens but no ledger is supplied", async () => {
    await expect(
      createPolicyRuntime({
        file: makeFile({ tenants: { "tenant-a": { compose: { budget: { dailyTokens: 5 } } } } }),
      }),
    ).rejects.toThrow(/tenants\.tenant-a\.compose\.budget\.dailyTokens/);
  });

  it("throws when rateLimits declare a rule but no rateLimitStore is supplied", async () => {
    await expect(
      createPolicyRuntime({
        file: makeFile({ defaults: { rateLimits: { compose: { capacity: 1, refillPerSecond: 1 } } } }),
      }),
    ).rejects.toThrow(/defaults\.rateLimits.*rateLimitStore/);
  });

  it("does not throw for an empty rateLimits section, or when the dependencies are supplied", async () => {
    await expect(
      createPolicyRuntime({ file: makeFile({ defaults: { rateLimits: {} } }) }),
    ).resolves.toBeDefined();
    await expect(
      createPolicyRuntime({
        file: makeFile({
          defaults: {
            compose: { budget: { dailyTokens: 5 } },
            rateLimits: { action: { capacity: 1, refillPerSecond: 1 } },
          },
        }),
        ledger: createDailyTokenLedger(),
        rateLimitStore: { take: async () => ({ allow: true }) },
      }),
    ).resolves.toBeDefined();
  });
});

describe("createPolicyRuntime: bounded / shared memos", () => {
  it("undeclared tenants resolve to the defaults section, including ids that name Object.prototype members", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile({
        defaults: { governance: { roles: { admin: ["*"] } } },
        tenants: { "tenant-a": { governance: { roles: { viewer: ["lineage.read"] } } } },
      }),
    });
    expect(runtime.rolesFor("x1")).toEqual({ admin: ["*"] });
    expect(runtime.rolesFor("x2")).toEqual({ admin: ["*"] });
    expect(runtime.rolesFor("constructor")).toEqual({ admin: ["*"] });
    expect(runtime.rolesFor("tenant-a")).toEqual({ admin: ["*"], viewer: ["lineage.read"] });
  });

  it("rolesFor observes a reload (the section memo is cleared)", async () => {
    const runtime = await createPolicyRuntime({
      file: makeFile({ defaults: { governance: { roles: { admin: ["*"] } } } }),
    });
    expect(runtime.rolesFor()).toEqual({ admin: ["*"] });
    await runtime.reload(makeFile({ defaults: { governance: { roles: { viewer: ["lineage.read"] } } } }));
    expect(runtime.rolesFor()).toEqual({ viewer: ["lineage.read"] });
  });

  it("the policyFor memo is LRU-bounded: a flood of distinct tenant ids evicts the oldest entry", async () => {
    const base: ComposePolicy = {};
    const runtime = await createPolicyRuntime({ file: makeFile(), basePolicyFor: () => base });
    const first = runtime.policyFor({ surface: "web", tenant: "t-first" });
    for (let i = 0; i < DEFAULT_MAX_MEMORY_ENTRIES; i += 1) {
      runtime.policyFor({ surface: "web", tenant: `flood-${i}` });
      // Re-access mid-flood: recency, not insertion order, decides survival (a FIFO memo would evict it).
      if (i === Math.floor(DEFAULT_MAX_MEMORY_ENTRIES / 2)) {
        expect(runtime.policyFor({ surface: "web", tenant: "t-first" })).toBe(first);
      }
    }
    expect(runtime.policyFor({ surface: "web", tenant: "t-first" })).toBe(first); // recently used, survives
    const recent = runtime.policyFor({ surface: "web", tenant: `flood-${DEFAULT_MAX_MEMORY_ENTRIES - 1}` });
    expect(runtime.policyFor({ surface: "web", tenant: `flood-${DEFAULT_MAX_MEMORY_ENTRIES - 1}` })).toBe(
      recent,
    );
  });
});
