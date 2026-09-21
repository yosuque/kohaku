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
import { deniedMessage } from "./ui.js";

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
 * GET /lineage, newest first. Failures are left to the host error surface (the sample never notified here).
 * The event list is reversed here (not in the tab): every future consumer of this hook — not just the sample's
 * LineageTab — should get "newest first" as the hook's contract, matching what the raw `apiFetch` call the
 * hook replaces used to do client-side.
 */
export function useLineage(query: LineageQuery = DEFAULT_LINEAGE_QUERY): {
  events: LineageEventRecord[];
  reload: () => void;
} {
  const { client } = useAdmin();
  const [events, setEvents] = useState<LineageEventRecord[]>([]);
  const guard = useResultGuard();
  const key = JSON.stringify(query);
  const reload = useCallback(() => {
    const stillCurrent = guard();
    void client.lineage(JSON.parse(key) as LineageQuery).then((list) => {
      if (stillCurrent()) setEvents([...list].reverse());
    });
  }, [client, key, guard]);
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
        const denied = isKohakuHostError(e) ? deniedMessage(e, m.analytics.opRead, m) : null;
        notify(denied ?? m.analytics.fetchFailed, "error");
        setData(null);
      });
  }, [client, notify, getMessages, guard]);
  useEffect(reload, [reload]);
  return { data, reload };
}

/**
 * "all" digs up candidates via POST /promotions/evaluate (automatic nomination); a specific status narrows via
 * GET /promotions?status= (read-only). viewer lacks promotion.evaluate but has promotion.list, so only "all" can be denied.
 * The nomination threshold for the empty-state copy is read from the analytics summary (never a literal).
 */
export function usePromotions(statusFilter: string): {
  candidates: PromotionCandidateView[];
  promotionMinUses: number | null;
  reload: () => void;
} {
  const { client, notify, getMessages } = useAdmin();
  const [candidates, setCandidates] = useState<PromotionCandidateView[]>([]);
  const [promotionMinUses, setPromotionMinUses] = useState<number | null>(null);
  const guard = useResultGuard();
  const reload = useCallback(() => {
    const stillCurrent = guard();
    const isAll = statusFilter === "all";
    void (isAll ? client.promotions.evaluate() : client.promotions.list({ status: statusFilter }))
      .then((result) => {
        if (stillCurrent()) setCandidates(result);
      })
      .catch((e: unknown) => {
        if (!stillCurrent()) return;
        const m = getMessages();
        const denied = isKohakuHostError(e)
          ? deniedMessage(e, isAll ? m.promotions.opEvaluate : m.promotions.opList, m)
          : null;
        if (denied != null) notify(denied, "error");
        setCandidates([]);
      });
    void client.analytics
      .summary()
      .then((s) => {
        if (stillCurrent()) setPromotionMinUses(s.promotionPolicy?.promotionMinUses ?? null);
      })
      .catch(() => {
        if (stillCurrent()) setPromotionMinUses(null);
      });
  }, [client, notify, getMessages, statusFilter, guard]);
  useEffect(reload, [reload]);
  return { candidates, promotionMinUses, reload };
}

/** GET /fixations/proposals + GET /fixations, plus the fixation-nomination threshold from the analytics summary. */
export function useFixations(): {
  proposals: FixationProposalView[];
  records: FixationRecordView[];
  fixationMinUses: number | null;
  reload: () => void;
} {
  const { client } = useAdmin();
  const [proposals, setProposals] = useState<FixationProposalView[]>([]);
  const [records, setRecords] = useState<FixationRecordView[]>([]);
  const [fixationMinUses, setFixationMinUses] = useState<number | null>(null);
  const guard = useResultGuard();
  const reload = useCallback(() => {
    const stillCurrent = guard();
    void client.fixations.proposals().then((result) => {
      if (stillCurrent()) setProposals(result);
    });
    void client.fixations.list().then((result) => {
      if (stillCurrent()) setRecords(result);
    });
    void client.analytics
      .summary()
      .then((s) => {
        if (stillCurrent()) setFixationMinUses(s.promotionPolicy?.fixationMinUses ?? null);
      })
      .catch(() => {
        if (stillCurrent()) setFixationMinUses(null);
      });
  }, [client, guard]);
  useEffect(reload, [reload]);
  return { proposals, records, fixationMinUses, reload };
}
