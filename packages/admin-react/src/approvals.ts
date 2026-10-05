import { actionPayloadHash, type JsonObject, type LineageEventRecord } from "@kohaku-ui/spec-core";

/**
 * One row of the approver's inbox: an `"approve"`-tier governed Action that a requester attempted without a
 * valid approval token and that has not been settled since. Rows are keyed by `(requester, action,
 * payloadHash)` — the same triple an approval token is bound to (design.md #63) — so a requester pressing the
 * button three times is one row with `count: 3`, not three.
 */
export interface PendingApproval {
  /** `${requesterId ?? ""}|${action}|${payloadHash}`. Stable across reloads; usable as a React key. */
  key: string;
  action: string;
  payloadHash: string;
  /** The requester's principal (the lineage record's `actor.id`). Absent when the host recorded no actor id. */
  requesterId?: string;
  /**
   * `requestId`s of the still-unsettled `action.approvalRequested` events folded into this row, oldest first.
   * Requests that an earlier `action.approved` already settled are not listed.
   */
  requestIds: string[];
  /** How many still-unsettled `approvalRequested` events (requests) are folded into this row. */
  count: number;
  /** `ts` of the most recent request. */
  latestTs: string;
  /** The first recorded payload of the unsettled requests. Present only when the host records payloads (`recordPayload: true`). */
  payload?: unknown;
  /**
   * Present only together with `payload`. `"ok"`: the recorded payload hashes to `payloadHash`. `"mismatch"`:
   * it does not (the displayed payload cannot be trusted). `"unverifiable"`: the re-hash itself failed (for
   * example no WebCrypto in this environment), so nothing can be said either way.
   */
  payloadHashState?: "ok" | "mismatch" | "unverifiable";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function keyOf(requesterId: string | undefined, action: string, payloadHash: string): string {
  return `${requesterId ?? ""}|${action}|${payloadHash}`;
}

/** ISO timestamps compare by instant; an unparseable `ts` falls back to string order. */
function compareTs(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b ? -1 : a > b ? 1 : 0;
  return ta - tb;
}

interface RequestRecord {
  ts: string;
  requestId: string | undefined;
  payload: unknown;
}

interface Group {
  action: string;
  payloadHash: string;
  requesterId: string | undefined;
  requests: RequestRecord[];
}

async function payloadHashStateOf(
  payload: unknown,
  payloadHash: string,
): Promise<"ok" | "mismatch" | "unverifiable"> {
  if (!isJsonObject(payload)) return "mismatch";
  try {
    return (await actionPayloadHash(payload)) === payloadHash ? "ok" : "mismatch";
  } catch {
    return "unverifiable";
  }
}

/**
 * Derives the pending-approval list from lineage events alone (design.md #72): no server-side pending store, no
 * dedicated route. For each `(requester, action, payloadHash)` it takes the `action.approvalRequested` events of
 * the `"approve"` tier (the confirm tier also emits that event type), and subtracts whatever settled them
 * earlier: an `action.approved` (the approval token was verified on invoke, keyed by its `requesterId`). Only
 * the requests newer than the latest `action.approved` count (`count`, `requestIds`, `payload`); a row with none
 * left is not pending. `action.denied` never settles a row (a denied attempt is not an approval), and neither
 * does `action.invoked`: the tab reads only the three event types it needs, and an `"approve"`-tier invoke is
 * always preceded by the `action.approved` that verified its token.
 *
 * `events` may arrive in any order (it is sorted by `ts` here). Tenant is deliberately not part of the key:
 * `GET /lineage` is already tenant-scoped by the host. Result is newest-request first.
 *
 * Async because the recorded payload (when the host records it) is re-hashed with spec-core's
 * `actionPayloadHash` (WebCrypto) to detect a payload that no longer matches its hash. A re-hash that throws
 * marks only that row `payloadHashState: "unverifiable"`; it never fails the whole derivation.
 */
export async function derivePendingApprovals(
  events: readonly LineageEventRecord[],
): Promise<PendingApproval[]> {
  const ordered = [...events].sort((a, b) => compareTs(a.ts, b.ts));

  const groups = new Map<string, Group>();
  const settledAt = new Map<string, string>();

  for (const ev of ordered) {
    const action = str(ev.payload.action);
    const payloadHash = str(ev.payload.payloadHash);
    if (action == null || payloadHash == null) continue;

    if (ev.type === "action.approvalRequested") {
      if (ev.payload.tier !== "approve") continue;
      const key = keyOf(ev.actor.id, action, payloadHash);
      let group = groups.get(key);
      if (group == null) {
        group = { action, payloadHash, requesterId: ev.actor.id, requests: [] };
        groups.set(key, group);
      }
      group.requests.push({ ts: ev.ts, requestId: str(ev.payload.requestId), payload: ev.payload.payload });
    } else if (ev.type === "action.approved") {
      const key = keyOf(str(ev.payload.requesterId), action, payloadHash);
      const prev = settledAt.get(key);
      if (prev == null || compareTs(ev.ts, prev) > 0) settledAt.set(key, ev.ts);
    }
  }

  const pending: PendingApproval[] = [];
  for (const [key, group] of groups) {
    const settled = settledAt.get(key);
    const open =
      settled == null ? group.requests : group.requests.filter((r) => compareTs(r.ts, settled) > 0);
    const latest = open.at(-1);
    if (latest == null) continue;
    const row: PendingApproval = {
      key,
      action: group.action,
      payloadHash: group.payloadHash,
      requestIds: open.flatMap((r) => (r.requestId != null ? [r.requestId] : [])),
      count: open.length,
      latestTs: latest.ts,
    };
    if (group.requesterId != null) row.requesterId = group.requesterId;
    const recorded = open.find((r) => r.payload !== undefined);
    if (recorded != null) {
      row.payload = recorded.payload;
      row.payloadHashState = await payloadHashStateOf(recorded.payload, group.payloadHash);
    }
    pending.push(row);
  }
  return pending.sort((a, b) => compareTs(b.latestTs, a.latestTs));
}
