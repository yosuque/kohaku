import { actionPayloadHash, type LineageEventRecord } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePendingApprovals } from "../src/index.js";

let seq = 0;
function ev(
  type: string,
  ts: string,
  payload: Record<string, unknown>,
  actorId: string | null = "demo-viewer",
): LineageEventRecord {
  seq += 1;
  return {
    id: `e${seq}`,
    ts,
    type,
    actor: actorId !== null ? { kind: "user", id: actorId } : { kind: "user" },
    payload,
  };
}

const requested = (ts: string, extra: Record<string, unknown> = {}, actorId?: string | null) =>
  ev(
    "action.approvalRequested",
    ts,
    { action: "sales.refund", payloadHash: "sha256:aaa", tier: "approve", requestId: `r-${ts}`, ...extra },
    actorId === null ? null : (actorId ?? "demo-viewer"),
  );
const approved = (ts: string, requesterId: string | null = "demo-viewer") =>
  ev(
    "action.approved",
    ts,
    {
      action: "sales.refund",
      payloadHash: "sha256:aaa",
      approverId: "demo-approver",
      ...(requesterId !== null ? { requesterId } : {}),
    },
    "demo-viewer",
  );
const invoked = (ts: string, tier = "approve") =>
  ev("action.invoked", ts, { action: "sales.refund", payloadHash: "sha256:aaa", tier });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("derivePendingApprovals", () => {
  it("drops the confirm tier (it also emits approvalRequested)", async () => {
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z", { tier: "confirm" }),
      requested("2026-10-05T10:01:00.000Z", { action: "sales.other" }),
    ]);
    expect(out.map((r) => r.action)).toEqual(["sales.other"]);
  });

  it("folds repeated requests of the same (requester, action, payloadHash) into one row", async () => {
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z"),
      requested("2026-10-05T10:05:00.000Z"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: "demo-viewer|sales.refund|sha256:aaa",
      requesterId: "demo-viewer",
      count: 2,
      latestTs: "2026-10-05T10:05:00.000Z",
      requestIds: ["r-2026-10-05T10:00:00.000Z", "r-2026-10-05T10:05:00.000Z"],
    });
  });

  it("keeps different requesters apart", async () => {
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z"),
      requested("2026-10-05T10:01:00.000Z", {}, "demo-admin"),
    ]);
    expect(out.map((r) => r.requesterId).sort()).toEqual(["demo-admin", "demo-viewer"]);
  });

  it("is settled by a later action.approved", async () => {
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z"),
      approved("2026-10-05T10:10:00.000Z"),
    ]);
    expect(out).toEqual([]);
  });

  it("is pending again when a new request comes after the approved event, counting only that request", async () => {
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z"),
      requested("2026-10-05T10:05:00.000Z"),
      approved("2026-10-05T10:10:00.000Z"),
      requested("2026-10-05T10:20:00.000Z"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      latestTs: "2026-10-05T10:20:00.000Z",
      count: 1,
      requestIds: ["r-2026-10-05T10:20:00.000Z"],
    });
  });

  it("takes the recorded payload only from the requests that are still open", async () => {
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z", { payload: { amount: 1 } }),
      approved("2026-10-05T10:10:00.000Z"),
      requested("2026-10-05T10:20:00.000Z", { payload: { amount: 2 } }),
    ]);
    expect(out[0]!.payload).toEqual({ amount: 2 });
  });

  it("is not settled by action.invoked (the tab does not even read that event type)", async () => {
    expect(
      await derivePendingApprovals([
        requested("2026-10-05T10:00:00.000Z"),
        invoked("2026-10-05T10:10:00.000Z"),
        invoked("2026-10-05T10:11:00.000Z", "confirm"),
      ]),
    ).toHaveLength(1);
  });

  it("does not treat action.denied as settled", async () => {
    const denied = ev("action.denied", "2026-10-05T10:10:00.000Z", {
      action: "sales.refund",
      payloadHash: "sha256:aaa",
      reason: "x",
    });
    expect(await derivePendingApprovals([requested("2026-10-05T10:00:00.000Z"), denied])).toHaveLength(1);
  });

  it("accepts events in any order", async () => {
    const out = await derivePendingApprovals([
      approved("2026-10-05T10:10:00.000Z"),
      requested("2026-10-05T10:00:00.000Z"),
    ]);
    expect(out).toEqual([]);
  });

  it("leaves requesterId undefined when the record has no actor.id, and matches approved with no requesterId", async () => {
    const out = await derivePendingApprovals([requested("2026-10-05T10:00:00.000Z", {}, null)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.requesterId).toBeUndefined();
    expect("requesterId" in out[0]!).toBe(false);
    expect(out[0]!.key).toBe("|sales.refund|sha256:aaa");
    expect(
      await derivePendingApprovals([
        requested("2026-10-05T10:00:00.000Z", {}, null),
        approved("2026-10-05T10:10:00.000Z", null),
      ]),
    ).toEqual([]);
  });

  it("sorts newest request first", async () => {
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z", { action: "a.one" }),
      requested("2026-10-05T10:30:00.000Z", { action: "a.two" }),
      requested("2026-10-05T10:15:00.000Z", { action: "a.three" }),
    ]);
    expect(out.map((r) => r.action)).toEqual(["a.two", "a.three", "a.one"]);
  });

  it("carries the first recorded payload and flags a payload that does not hash to payloadHash", async () => {
    const payload = { orderId: "o-1", amount: 10 };
    const hash = await actionPayloadHash(payload);
    const ok = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z", { payloadHash: hash, payload }),
    ]);
    expect(ok[0]!.payload).toEqual(payload);
    expect(ok[0]!.payloadHashState).toBe("ok");

    const bad = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z", { payloadHash: hash, payload: { orderId: "o-1", amount: 9999 } }),
    ]);
    expect(bad[0]!.payloadHashState).toBe("mismatch");

    const none = await derivePendingApprovals([requested("2026-10-05T10:00:00.000Z")]);
    expect(none[0]!.payload).toBeUndefined();
    expect(none[0]!.payloadHashState).toBeUndefined();
  });

  it("marks only the row whose payload cannot be re-hashed as unverifiable instead of failing the whole inbox", async () => {
    const payload = { orderId: "o-1" };
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no WebCrypto"));
    const out = await derivePendingApprovals([
      requested("2026-10-05T10:00:00.000Z", { action: "a.with-payload", payload }),
      requested("2026-10-05T10:01:00.000Z", { action: "a.without-payload" }),
    ]);
    expect(out.map((r) => [r.action, r.payloadHashState])).toEqual([
      ["a.without-payload", undefined],
      ["a.with-payload", "unverifiable"],
    ]);
  });
});
