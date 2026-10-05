import type { LineageEventRecord, LineagePage, LineagePageRequest } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { iterateLineagePages } from "../src/index.js";

function event(id: string): LineageEventRecord {
  return {
    id,
    ts: "2026-07-01T00:00:00.000Z",
    actor: { kind: "system" },
    type: "view.composed",
    payload: {},
  };
}

/** A source that serves the given pages in order, recording every request it receives. */
function scripted(pages: LineagePage[]): {
  source: { pageLineage(req: LineagePageRequest): Promise<LineagePage> };
  requests: LineagePageRequest[];
} {
  const requests: LineagePageRequest[] = [];
  return {
    requests,
    source: {
      async pageLineage(req) {
        requests.push(req);
        const page = pages[requests.length - 1];
        if (page == null) throw new Error("scripted source ran out of pages");
        return page;
      },
    },
  };
}

async function collect(gen: AsyncGenerator<LineageEventRecord[], void>): Promise<LineageEventRecord[][]> {
  const out: LineageEventRecord[][] = [];
  for await (const page of gen) out.push(page);
  return out;
}

describe("iterateLineagePages", () => {
  it("yields each page's events in order, following nextCursor until it is absent", async () => {
    const { source, requests } = scripted([
      { events: [event("a"), event("b")], nextCursor: "c1" },
      { events: [event("c")], nextCursor: "c2" },
      { events: [event("d")] },
    ]);
    const pages = await collect(iterateLineagePages(source, { since: "2026-07-01T00:00:00.000Z" }));
    expect(pages.map((p) => p.map((e) => e.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    // The first request carries no cursor; every later one carries the previous page's nextCursor.
    expect(requests.map((r) => r.cursor)).toEqual([undefined, "c1", "c2"]);
    expect("cursor" in requests[0]!).toBe(false);
  });

  it("passes the request's filter and pageSize to every page call", async () => {
    const { source, requests } = scripted([{ events: [], nextCursor: "c1" }, { events: [event("a")] }]);
    await collect(
      iterateLineagePages(source, {
        tenant: "acme",
        type: ["view.composed"],
        since: "2026-07-01T00:00:00.000Z",
        until: "2026-07-31T23:59:59.999Z",
        pageSize: 50,
      }),
    );
    for (const r of requests) {
      expect(r).toMatchObject({
        tenant: "acme",
        type: ["view.composed"],
        since: "2026-07-01T00:00:00.000Z",
        until: "2026-07-31T23:59:59.999Z",
        pageSize: 50,
      });
    }
  });

  it("keeps following the cursor through an empty page (a selective filter can run out of budget)", async () => {
    const { source } = scripted([
      { events: [], nextCursor: "c1" },
      { events: [], nextCursor: "c2" },
      { events: [event("z")] },
    ]);
    const pages = await collect(iterateLineagePages(source, {}));
    expect(pages.map((p) => p.length)).toEqual([0, 0, 1]);
  });

  it("refuses a cursor that does not advance, after yielding the page that carried it", async () => {
    const { source } = scripted([
      { events: [event("a")], nextCursor: "same" },
      { events: [event("b")], nextCursor: "same" },
    ]);
    const seen: string[] = [];
    const walk = async (): Promise<void> => {
      for await (const page of iterateLineagePages(source, {})) seen.push(...page.map((e) => e.id));
    };
    await expect(walk()).rejects.toThrow(/same nextCursor/);
    expect(seen).toEqual(["a", "b"]);
  });

  it("is lazy: no page is requested until the generator is iterated, and stopping early stops the walk", async () => {
    const { source, requests } = scripted([
      { events: [event("a")], nextCursor: "c1" },
      { events: [event("b")] },
    ]);
    const gen = iterateLineagePages(source, {});
    expect(requests).toHaveLength(0);
    for await (const _page of gen) break;
    expect(requests).toHaveLength(1);
  });
});
