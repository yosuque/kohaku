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
  /** `requestId`s of the `action.approvalRequested` events folded into this row, oldest first. */
  requestIds: string[];
  /** How many `approvalRequested` events (requests) are folded into this row. */
  count: number;
  /** `ts` of the most recent request. */
  latestTs: string;
  /** The first recorded payload. Present only when the host records payloads (`recordPayload: true`). */
  payload?: unknown;
  /** True when the recorded `payload` does not hash to `payloadHash` (the displayed payload cannot be trusted). */
  payloadHashMismatch?: boolean;
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

/**
 * Derives the pending-approval list from lineage events alone (design.md #72): no server-side pending store, no
 * dedicated route. For each `(requester, action, payloadHash)` it takes the `action.approvalRequested` events of
 * the `"approve"` tier (the confirm tier also emits that event type), and subtracts whatever settled it later —
 * an `action.approved` (the token was verified on invoke) or an `"approve"`-tier `action.invoked`. A row is
 * pending while its latest request is newer than its latest settlement. `action.denied` never settles a row (a
 * denied attempt is not an approval).
 *
 * `events` may arrive in any order (it is sorted by `ts` here). Tenant is deliberately not part of the key:
 * `GET /lineage` is already tenant-scoped by the host. Result is newest-request first.
 *
 * Async because the recorded payload (when the host records it) is re-hashed with spec-core's
 * `actionPayloadHash` (WebCrypto) to detect a payload that no longer matches its hash. `_now` is accepted so a
 * future expiry policy needs no signature change; today every unsettled row is pending regardless of age (the
 * tab shows the age instead).
 */
export async function derivePendingApprovals(
  events: readonly LineageEventRecord[],
  _now: Date,
): Promise<PendingApproval[]> {
  const ordered = [...events].sort((a, b) => compareTs(a.ts, b.ts));

  const rows = new Map<string, PendingApproval>();
  const settledAt = new Map<string, string>();
  const settle = (key: string, ts: string) => {
    const prev = settledAt.get(key);
    if (prev == null || compareTs(ts, prev) > 0) settledAt.set(key, ts);
  };

  for (const ev of ordered) {
    const action = str(ev.payload.action);
    const payloadHash = str(ev.payload.payloadHash);
    if (action == null || payloadHash == null) continue;

    if (ev.type === "action.approvalRequested") {
      if (ev.payload.tier !== "approve") continue;
      const key = keyOf(ev.actor.id, action, payloadHash);
      const requestId = str(ev.payload.requestId);
      const existing = rows.get(key);
      if (existing == null) {
        const row: PendingApproval = {
          key,
          action,
          payloadHash,
          requestIds: requestId != null ? [requestId] : [],
          count: 1,
          latestTs: ev.ts,
        };
        if (ev.actor.id != null) row.requesterId = ev.actor.id;
        if (ev.payload.payload !== undefined) row.payload = ev.payload.payload;
        rows.set(key, row);
      } else {
        existing.count += 1;
        existing.latestTs = ev.ts;
        if (requestId != null) existing.requestIds.push(requestId);
        if (existing.payload === undefined && ev.payload.payload !== undefined) {
          existing.payload = ev.payload.payload;
        }
      }
    } else if (ev.type === "action.approved") {
      settle(keyOf(str(ev.payload.requesterId), action, payloadHash), ev.ts);
    } else if (ev.type === "action.invoked" && ev.payload.tier === "approve") {
      settle(keyOf(ev.actor.id, action, payloadHash), ev.ts);
    }
  }

  const pending: PendingApproval[] = [];
  for (const row of rows.values()) {
    const settled = settledAt.get(row.key);
    if (settled != null && compareTs(row.latestTs, settled) <= 0) continue;
    if (row.payload !== undefined) {
      const matches = isJsonObject(row.payload) && (await actionPayloadHash(row.payload)) === row.payloadHash;
      if (!matches) row.payloadHashMismatch = true;
    }
    pending.push(row);
  }
  return pending.sort((a, b) => compareTs(b.latestTs, a.latestTs));
}
