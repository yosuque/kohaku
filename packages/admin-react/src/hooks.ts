import {
  type AnalyticsSummaryView,
  type FixationProposalView,
  type FixationRecordView,
  isKohakuHostError,
  type LineageQuery,
  type PromotionCandidateView,
} from "@kohaku-ui/client";
import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdmin } from "./context.js";
import { describeDeniedOperation } from "./rbac.js";

const DEFAULT_LINEAGE_QUERY: LineageQuery = { limit: 120 };

/**
 * Tracks whether the calling component is still mounted and, per call, whether a newer `reload()` has already
 * superseded it — so a response that resolves after unmount (or after the query/filter changed again) is
 * dropped instead of calling a state setter on a stale render. `guard()` returns a function that is only `true`
 * while both conditions still hold; call it right before every `setState` inside a `reload`.
 */
function useResultGuard(): () => () => boolean {
  const mountedRef = useRef(true);
  const tokenRef = useRef(0);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  return useCallback(() => {
    const token = ++tokenRef.current;
    return () => mountedRef.current && token === tokenRef.current;
  }, []);
}

/**
 * GET /lineage, newest first. A 403 becomes the role explanation, anything else the generic fetchFailed text —
 * both surfaced via `notify` rather than left as an unhandled rejection. The event list is reversed here (not
 * in the tab): every future consumer of this hook — not just the sample's LineageTab — should get "newest
 * first" as the hook's contract, matching what the raw `apiFetch` call the hook replaces used to do client-side.
 */
export function useLineage(query: LineageQuery = DEFAULT_LINEAGE_QUERY): {
  events: LineageEventRecord[];
  reload: () => void;
} {
  const { client, notify, getMessages } = useAdmin();
  const [events, setEvents] = useState<LineageEventRecord[]>([]);
  const guard = useResultGuard();
  const key = JSON.stringify(query);
  const reload = useCallback(() => {
    const stillCurrent = guard();
    void client
      .lineage(JSON.parse(key) as LineageQuery)
      .then((list) => {
        if (stillCurrent()) setEvents([...list].reverse());
      })
      .catch((e: unknown) => {
        if (!stillCurrent()) return;
        const m = getMessages();
        const denied = isKohakuHostError(e) ? describeDeniedOperation(e, m.lineage.opRead, m) : null;
        notify(denied ?? m.lineage.fetchFailed, "error");
        setEvents([]);
      });
  }, [client, key, guard, notify, getMessages]);
  useEffect(reload, [reload]);
  return { events, reload };
}

/** GET /analytics/summary. A 403 becomes the role explanation; any other failure the generic fetchFailed text. */
export function useAnalyticsSummary(): { data: AnalyticsSummaryView | null; reload: () => void } {
  const { client, notify, getMessages } = useAdmin();
  const [data, setData] = useState<AnalyticsSummaryView | null>(null);
  const guard = useResultGuard();
  const reload = useCallback(() => {
    const stillCurrent = guard();
    void client.analytics
      .summary()
      .then((result) => {
        if (stillCurrent()) setData(result);
      })
      .catch((e: unknown) => {
        if (!stillCurrent()) return;
        const m = getMessages();
        const denied = isKohakuHostError(e) ? describeDeniedOperation(e, m.analytics.opRead, m) : null;
        notify(denied ?? m.analytics.fetchFailed, "error");
        setData(null);
      });
  }, [client, notify, getMessages, guard]);
  useEffect(reload, [reload]);
  return { data, reload };
}

/**
 * Every status (including "all") narrows via GET /promotions?status= (read-only; "all" omits the query
 * entirely). Extracting new candidates via POST /promotions/evaluate is a separate, explicit toolbar action in
 * PromotionsTab, not something this read fires as a side effect. The nomination threshold for the empty-state
 * copy comes from `useAdmin()` (fetched once per (client, tenant) by AdminProvider), not from a per-reload
 * `analytics.summary()` call here.
 */
export function usePromotions(statusFilter: string): {
  candidates: PromotionCandidateView[];
  promotionMinUses: number | null;
  reload: () => void;
} {
  const { client, notify, getMessages, promotionMinUses } = useAdmin();
  const [candidates, setCandidates] = useState<PromotionCandidateView[]>([]);
  const guard = useResultGuard();
  const reload = useCallback(() => {
    const stillCurrent = guard();
    void client.promotions
      .list(statusFilter === "all" ? undefined : { status: statusFilter })
      .then((result) => {
        if (stillCurrent()) setCandidates(result);
      })
      .catch((e: unknown) => {
        if (!stillCurrent()) return;
        const m = getMessages();
        const denied = isKohakuHostError(e) ? describeDeniedOperation(e, m.promotions.opList, m) : null;
        if (denied != null) notify(denied, "error");
        setCandidates([]);
      });
  }, [client, notify, getMessages, statusFilter, guard]);
  useEffect(reload, [reload]);
  return { candidates, promotionMinUses, reload };
}

/**
 * GET /fixations/proposals + GET /fixations. A 403 on either becomes the role explanation, anything else the
 * generic fetchFailed text. The fixation-nomination threshold comes from `useAdmin()` (fetched once per
 * (client, tenant) by AdminProvider), not from a per-reload `analytics.summary()` call here.
 */
export function useFixations(): {
  proposals: FixationProposalView[];
  records: FixationRecordView[];
  fixationMinUses: number | null;
  reload: () => void;
} {
  const { client, notify, getMessages, fixationMinUses } = useAdmin();
  const [proposals, setProposals] = useState<FixationProposalView[]>([]);
  const [records, setRecords] = useState<FixationRecordView[]>([]);
  const guard = useResultGuard();
  const reload = useCallback(() => {
    const stillCurrent = guard();
    const onError = (e: unknown, setEmpty: () => void) => {
      if (!stillCurrent()) return;
      const m = getMessages();
      const denied = isKohakuHostError(e) ? describeDeniedOperation(e, m.fixations.opRead, m) : null;
      notify(denied ?? m.fixations.fetchFailed, "error");
      setEmpty();
    };
    void client.fixations
      .proposals()
      .then((result) => {
        if (stillCurrent()) setProposals(result);
      })
      .catch((e: unknown) => onError(e, () => setProposals([])));
    void client.fixations
      .list()
      .then((result) => {
        if (stillCurrent()) setRecords(result);
      })
      .catch((e: unknown) => onError(e, () => setRecords([])));
  }, [client, notify, getMessages, guard]);
  useEffect(reload, [reload]);
  return { proposals, records, fixationMinUses, reload };
}
