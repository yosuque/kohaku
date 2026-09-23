/**
 * Typed dictionary for every string the console renders. Products inject a translated object through
 * `AdminProvider` / `KohakuAdmin` `messages`; the English default below is the one the kohaku sample ships.
 * Untranslated by policy (technical identifiers): status codes (candidate / published / …), tier names,
 * cache kinds, and metric names (view.composed etc.). Parameterized messages are functions.
 *
 * Sample-specific strings (the Gallery tab and the "bump data version" demo button) are NOT part of this
 * dictionary — they stay in the sample app's own i18n as an intersection type over `AdminMessages`.
 */
export interface AdminMessages {
  tabLineage: string;
  tabAnalytics: string;
  tabPromotions: string;
  tabFixations: string;
  refresh: string;
  deniedMessage: (code: string, operation: string) => string;
  emptyDefault: string;
  lineage: { description: string; empty: string };
  analytics: {
    description: (limit: number, truncated: boolean, events: number) => string;
    loading: string;
    fetchFailed: string;
    opRead: string;
    fallbackRateLabel: string;
    latencyLabel: string;
    fixationsLabel: string;
    eventsSub: (n: number) => string;
    unfixatedSub: (n: number) => string;
    tierDistribution: string;
    cacheBreakdown: string;
    fallbackBreakdown: string;
    noFallbacks: string;
    topIntents: string;
    noComposeRecords: string;
    promotionLifecycle: string;
    reviewTurnaround: string;
    reviewTurnaroundSub: (p95: string, count: number) => string;
    acceptedAsIs: string;
    acceptedAsIsSub: (suggested: number) => string;
  };
  fixations: {
    description: string;
    candidatesTitle: string;
    /** minUses is the fixation-nomination threshold, sourced from GET /analytics/summary's promotionPolicy. */
    candidatesEmpty: (minUses: number) => string;
    usesStability: (uses: number, stabilityPct: string) => string;
    fixateButton: string;
    fixatedNotice: (canonical: string) => string;
    fixateFailed: string;
    opApprove: string;
    fixatedTitle: string;
    none: string;
    removeButton: string;
    removeFailed: string;
    opRemove: string;
  };
  promotions: {
    description: string;
    statusLabel: string;
    statusAllOption: string;
    /** minUses is the promotion-nomination threshold, sourced from GET /analytics/summary's promotionPolicy. */
    emptyAll: (minUses: number) => string;
    emptyStatus: (status: string) => string;
    opEvaluate: string;
    opList: string;
    opApprove: string;
    opWithdraw: string;
    opReject: string;
    opPreview: string;
    requestChangesNotice: string;
    reApprovedNotice: (componentType: string, version: string) => string;
    promotedNotice: (componentType: string, version: string, intentName: string) => string;
    withdrawnNotice: string;
    rejectedNotice: string;
    failedNotice: (message: string) => string;
    usesSessions: (uses: number, sessions: number) => string;
    changesRequestedBanner: string;
    generatedHtml: (kb: string) => string;
    descriptionFieldLabel: string;
    schemaDetailsSummary: string;
    paramsJsonSchemaLabel: string;
    queryPathLabel: string;
    queryPathDefaultOption: string;
    fixedParamsLabel: string;
    paramMapLabel: string;
    invalidJson: (label: string, message: string) => string;
    approveResubmitButton: string;
    approveButton: string;
    requestChangesButton: string;
    withdrawButton: string;
    rejectButton: string;
    unpublishButton: string;
    previewButton: string;
    previewLoading: string;
    closePreview: string;
    previewNoRefWarning: string;
    previewFetchFailed: (message: string) => string;
    previewMalformed: string;
    suggestionBadge: (model: string, confidencePct: number) => string;
    suggestionTitle: string;
    suggestionUnchanged: string;
    suggestionChangedFrom: (suggested: string) => string;
    suggestionAcknowledge: string;
    suggestionAcknowledgeRequired: string;
    suggestionEvents: (names: string) => string;
  };
}

/** English defaults (verbatim from the kohaku sample's dictionary, minus the sample-only Gallery/bump keys). */
export const defaultAdminMessages: AdminMessages = {
  tabLineage: "View Lineage",
  tabAnalytics: "Analytics",
  tabPromotions: "Promotion Review (L2→L1)",
  tabFixations: "Fixation (L1→L0)",
  refresh: "Refresh",
  deniedMessage: (code, operation) =>
    `Permission denied (${code}): the current role is not allowed to "${operation}". Switch the role at the top-right of the header to admin / reviewer.`,
  emptyDefault: "No data",
  lineage: {
    description:
      'Event Sourcing of the UI Spec — rows where the same intentHash lines up across the web / chat surfaces are the audit trail of "same request → same rendering"',
    empty: "No events (they are recorded as you use the Dashboard / Chat)",
  },
  analytics: {
    description: (limit, truncated, events) =>
      `Overview of fallback rate, tier distribution, and latency. Aggregated over the most recent ${limit} events (default 200)` +
      (truncated ? " (window limit reached — older events are excluded)" : "") +
      `. ${events} events in scope.`,
    loading: "Loading… (with no activity yet, the summary is empty)",
    fetchFailed: "Failed to fetch the analytics summary",
    opRead: "viewing usage analytics (analytics.read)",
    fallbackRateLabel: "fallback rate",
    latencyLabel: "latency p95",
    fixationsLabel: "fixations",
    eventsSub: (n) => `${n} events`,
    unfixatedSub: (n) => `unfixated ${n}`,
    tierDistribution: "tier distribution",
    cacheBreakdown: "cache breakdown",
    fallbackBreakdown: "fallback breakdown (by kind)",
    noFallbacks: "No fallbacks",
    topIntents: "Top intents",
    noComposeRecords: "No compose records yet",
    promotionLifecycle: "Promotion lifecycle (event counts)",
    reviewTurnaround: "Review turnaround p50",
    reviewTurnaroundSub: (p95, count) => `p95 ${p95} · ${count} reviews`,
    acceptedAsIs: "Suggestions accepted as-is",
    acceptedAsIsSub: (suggested) => `of ${suggested} suggested`,
  },
  fixations: {
    description:
      "Fixating a frequent L1 Intent (whose structure is stable) makes it served via the L0 path that never goes through the LLM (structure is fixed; data stays live via $ref reference passing).",
    candidatesTitle: "Fixation candidates",
    candidatesEmpty: (minUses) =>
      `No candidates. They appear once an L1 view (e.g. trend) has been shown ${minUses} or more times.`,
    usesStability: (uses, pct) => `${uses} uses / stability ${pct}%`,
    fixateButton: "Fixate to L0",
    fixatedNotice: (canonical) => `Fixated: ${canonical} (from now on L0 / cache:FIXATED)`,
    fixateFailed: "Failed to fixate",
    opApprove: "L0 fixation (fixation.approve)",
    fixatedTitle: "Fixated",
    none: "None",
    removeButton: "Remove",
    removeFailed: "Failed to remove the fixation",
    opRemove: "removing a fixation (fixation.remove)",
  },
  promotions: {
    description:
      "Extract promotion candidates from the usage log of L2 (freely generated) parts. Once approved, they are registered into the Registry and the Intent catalog, and from then on the same request is served via L1 (declarative composition).",
    statusLabel: "status",
    statusAllOption: "all (extract candidates)",
    emptyAll: (minUses) =>
      `No candidates. Ask "Show sales as a calendar heatmap" in Chat ${minUses} or more times and a candidate appears.`,
    emptyStatus: (status) => `No promotions with status "${status}".`,
    opEvaluate: "extracting promotion candidates (promotion.evaluate)",
    opList: "viewing the promotion list (promotion.list)",
    opApprove: "approving a promotion",
    opWithdraw: "withdrawing a publication",
    opReject: "rejecting a candidate",
    opPreview: "previewing a promotion candidate (promotion.preview)",
    requestChangesNotice:
      'Requested changes (changes_requested). Fix it and recover via "Resubmit and approve".',
    reApprovedNotice: (componentType, version) =>
      `Re-approved and promoted: registered ${componentType}@${version} into the Registry.`,
    promotedNotice: (componentType, version, intentName) =>
      `Promotion complete: registered ${componentType}@${version} into the Registry and added the Intent "${intentName}". Ask the same question in Chat and it becomes L1.`,
    withdrawnNotice:
      "Withdrawn. The published entry is removed from the catalog and Intent, and the next compose returns to L1 / fallback.",
    rejectedNotice: "Rejected the candidate",
    failedNotice: (message) => `Failed: ${message}`,
    usesSessions: (uses, sessions) => `${uses} uses / ${sessions} sessions`,
    changesRequestedBanner:
      'Changes have been requested (sent back). Fix the draft and use "Resubmit and approve" to return it to candidate, rejoining the judge → human approval → publish chain.',
    generatedHtml: (kb) => `Generated HTML source (${kb} KB)`,
    descriptionFieldLabel: "description (selection guidance for the LLM)",
    schemaDetailsSummary: "Schema and data wiring (details)",
    paramsJsonSchemaLabel:
      "paramsJsonSchema (JSON Schema for props / intent params. Empty = product default)",
    queryPathLabel: "queryTemplate.path (empty = the default trend-fixed wiring)",
    queryPathDefaultOption: "(default / trend-fixed)",
    fixedParamsLabel: "fixedParams (JSON of fixed query params)",
    paramMapLabel: "paramMap (JSON mapping intent param → query param)",
    invalidJson: (label, message) => `${label} has invalid JSON: ${message}`,
    approveResubmitButton: "↻ Resubmit and approve (apply fixes → publish)",
    approveButton: "✓ Approve and register (judge → human approval → publish)",
    requestChangesButton: "Request changes (send back)",
    withdrawButton: "Withdraw",
    rejectButton: "Reject",
    unpublishButton: "Unpublish",
    previewButton: "▶ Preview (real render in an isolated iframe)",
    previewLoading: "Loading…",
    closePreview: "Close preview",
    previewNoRefWarning:
      "This candidate has no recorded data reference, so data fetching shows an error (only the visual skeleton can be checked).",
    previewFetchFailed: (message) => `Could not fetch the preview: ${message}`,
    previewMalformed: "The preview response is malformed",
    suggestionBadge: (model, confidencePct) => `Proposed by ${model} (confidence ${confidencePct}%)`,
    suggestionTitle: "Proposed schema (machine-extracted — review before approving)",
    suggestionUnchanged: "unchanged",
    suggestionChangedFrom: (suggested) => `was: ${suggested}`,
    suggestionAcknowledge: "I have reviewed the proposed schema against the preview",
    suggestionAcknowledgeRequired: "Confirm you reviewed the proposed schema before approving.",
    suggestionEvents: (names) => `Proposed events: ${names}`,
  },
};
