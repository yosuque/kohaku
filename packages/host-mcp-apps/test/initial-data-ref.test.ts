import type { DomainPort, JsonObject, TabularData } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { resolveVariantWithTimeout } from "../src/initial-data.js";
import type { ToolContext } from "../src/types.js";

// Characterization (pre-refactor): pins the exact ref-parsing / domain.invoke behavior of
// initial-data.ts's resolveVariant (no verify step here, by design — see the module doc comment)
// before the parse/merge step moves to host-core's parseInvokableRef.

const DATA: TabularData = {
  columns: [{ key: "month", type: "string" }],
  rows: [{ month: "2026-04" }],
  dataVersion: "sales@seed-1",
};

function captureDomain(): {
  domain: DomainPort;
  calls: { op: string; args: JsonObject }[];
} {
  const calls: { op: string; args: JsonObject }[] = [];
  return {
    calls,
    domain: {
      async listOperations() {
        return [];
      },
      async invoke(op, args) {
        calls.push({ op, args: args as JsonObject });
        return DATA;
      },
    },
  };
}

/** A minimal ToolContext stub: resolveVariant only reads deps.domain / deps.querySource / principal. */
function makeCtx(domain: DomainPort, querySource = "sales"): ToolContext {
  return {
    deps: { domain, querySource } as ToolContext["deps"],
    principal: { id: "tester", roles: ["user"] },
  } as unknown as ToolContext;
}

describe("resolveVariant ref parsing (initial-data.ts / host-core parity)", () => {
  it("plain ref: invokes with base.params only", async () => {
    const { domain, calls } = captureDomain();
    const ctx = makeCtx(domain);

    const result = await resolveVariantWithTimeout("query://sales/records?fy=2026", ctx, 1000);

    expect(result).toEqual(DATA);
    expect(calls).toEqual([{ op: "records", args: { fy: "2026" } }]);
  });

  it("ref with reserved params: merges reserved into invoke args", async () => {
    const { domain, calls } = captureDomain();
    const ctx = makeCtx(domain);

    const result = await resolveVariantWithTimeout(
      "query://sales/records?_cursor=100:v1&_dir=desc&_limit=50&_sort=revenue&fy=2026",
      ctx,
      1000,
    );

    expect(result).toEqual(DATA);
    expect(calls).toEqual([
      {
        op: "records",
        args: { fy: "2026", _cursor: "100:v1", _dir: "desc", _limit: "50", _sort: "revenue" },
      },
    ]);
  });

  it("unknown reserved param: rejects, no invoke performed", async () => {
    const { domain, calls } = captureDomain();
    const ctx = makeCtx(domain);

    await expect(
      resolveVariantWithTimeout("query://sales/records?_tenant=other&fy=2026", ctx, 1000),
    ).rejects.toThrow(/unknown reserved parameter "_tenant"/);
    expect(calls).toEqual([]);
  });

  it("source mismatch: resolves to null, no invoke performed (no verify step here)", async () => {
    const { domain, calls } = captureDomain();
    const ctx = makeCtx(domain);

    const result = await resolveVariantWithTimeout("query://other/records?fy=2026", ctx, 1000);

    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });
});
