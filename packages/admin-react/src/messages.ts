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
  tabApprovals: string;
  refresh: string;
  deniedMessage: (code: string, operation: string) => string;
  /** 401 (missing/expired session) — distinct from `deniedMessage`'s 403 role explanation. */
  authRequiredMessage: (code: string, operation: string) => string;
  emptyDefault: string;
  lineage: {
    description: string;
    empty: string;
    /** Operation label for the GET /lineage denied/failed explanation. */
    opRead: string;
    fetchFailed: string;
  };
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
    usageByDay: string;
    usageNote: (limit: number) => string;
    noUsage: string;
    usageDay: string;
    usageTenant: string;
    usageNoTenant: string;
    usageComposed: string;
    usageHit: string;
    usageMiss: string;
    usageL2Generated: string;
    usageTokensIn: string;
    usageTokensOut: string;
    usageCacheFixated: string;
    usageFixated: string;
    catalogGaps: string;
    catalogGapsNote: string;
    pendingPromotions: string;
    pendingPromotionsSub: string;
    pendingFetchFailed: string;
    l2Intents: string;
    gapIntent: string;
    gapGenerated: string;
    gapFallbacks: string;
    noL2Intents: string;
    editedSchemas: string;
    gapComponent: string;
    gapEdits: string;
    gapTopFields: string;
    noSchemaEdits: string;
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
    /** Operation label for the GET /fixations + GET /fixations/proposals denied/failed explanation. */
    opRead: string;
    fetchFailed: string;
  };
  approvals: {
    description: string;
    empty: string;
    requester: string;
    /** Shown for a row whose lineage record has no `actor.id` (the Approve button is disabled with this as its title). */
    requesterUnknown: string;
    /** Relative age of the latest request, `seconds` since it was recorded. */
    age: (seconds: number) => string;
    /** How many times the same (requester, action, payload) was attempted. */
    requestCount: (count: number) => string;
    requestIdLabel: string;
    payloadHashLabel: string;
    payloadLabel: string;
    payloadMismatch: string;
    /** Shown when the recorded payload could not be re-hashed at all (nothing can be said about it either way). */
    payloadUnverifiable: string;
    /** Notice shown when the inbox read reached its event cap, so older requests may be missing. */
    windowFull: (limit: number) => string;
    approveButton: string;
    /** Title of the disabled Approve button on a row whose recorded payload does not match its hash. */
    approveDisabledMismatch: string;
    /** Title of the disabled Approve button while an issued token is still within its TTL. */
    approveDisabledIssued: string;
    /** Info notice after a token is minted. */
    issuedNotice: (action: string) => string;
    tokenLabel: string;
    /** "issued N s ago (TTL M s)" under the token. */
    issuedAge: (seconds: number, ttlSeconds: number) => string;
    copyButton: string;
    copied: string;
    reissue: string;
    /** Generic failure of POST /approvals: the server's own message and the host's requestId, when there are any. */
    issueFailed: (message?: string, requestId?: string) => string;
    selfApproval: string;
    notConfigured: string;
    opIssue: string;
    /** Operation label for the GET /lineage denied/failed explanation. */
    opRead: string;
    fetchFailed: string;
  };
  promotions: {
    description: string;
    statusLabel: string;
    statusAllOption: string;
    /** minUses is the promotion-nomination threshold, sourced from GET /analytics/summary's promotionPolicy. */
    emptyAll: (minUses: number) => string;
    emptyStatus: (status: string) => string;
    /** Toolbar button that extracts candidates via POST /promotions/evaluate (side-effecting; the status filter itself is read-only). */
    evaluateButton: string;
    opEvaluate: string;
    opList: string;
    opApprove: string;
    /** Withdrawing a non-published candidate (e.g. from changes_requested) back out of the review queue. */
    opWithdraw: string;
    /** Unpublishing an already-published entry (removes it from the catalog and Intent). */
    opUnpublish: string;
    opReject: string;
    opPreview: string;
    requestChangesNotice: string;
    reApprovedNotice: (componentType: string, version: string) => string;
    promotedNotice: (componentType: string, version: string, intentName: string) => string;
    /** Shown after withdrawing a non-published candidate. Distinct from `unpublishedNotice`. */
    withdrawnNotice: string;
    /** Shown after unpublishing an already-published entry. Distinct from `withdrawnNotice`. */
    unpublishedNotice: string;
    rejectedNotice: string;
    failedNotice: (message: string) => string;
    usesSessions: (uses: number, sessions: number) => string;
    changesRequestedBanner: string;
    generatedHtml: (kb: string) => string;
    /** Generation provenance: shown when the candidate's origin (kit / generatorVersion) is known. kit is "id@version" or "—". */
    generatedWith: (kit: string, generatorVersion?: string) => string;
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
    suggestionEmptyValue: string;
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
  tabApprovals: "Approvals",
  refresh: "Refresh",
  deniedMessage: (code, operation) =>
    `Permission denied (${code}): the current role is not allowed to "${operation}". Switch the role at the top-right of the header to admin / reviewer.`,
  authRequiredMessage: (code, operation) =>
    `Sign-in required or session expired (${code}): the host rejected "${operation}". Sign in again.`,
  emptyDefault: "No data",
  lineage: {
    description:
      'Event Sourcing of the UI Spec — rows where the same intentHash lines up across the web / chat surfaces are the audit trail of "same request → same rendering"',
    empty: "No events (they are recorded as you use the Dashboard / Chat)",
    opRead: "viewing lineage events (lineage.read)",
    fetchFailed: "Failed to fetch lineage events",
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
    usageByDay: "Usage by day",
    usageNote: (limit) =>
      `A sample of the most recent ${limit} events in this window, not a complete count. For metering, use the kohaku usage export command.`,
    noUsage: "No usage in this window yet",
    usageDay: "day",
    usageTenant: "tenant",
    usageNoTenant: "(none)",
    usageComposed: "composed",
    usageHit: "hit",
    usageMiss: "miss",
    usageL2Generated: "L2 generated",
    usageTokensIn: "tokens in",
    usageTokensOut: "tokens out",
    usageCacheFixated: "fixated (served from fixation)",
    usageFixated: "fixated (fixation ops)",
    catalogGaps: "Catalog gaps",
    catalogGapsNote:
      "Where the catalog falls short: requests answered by free-form L2 generation, and the schemas reviewers had to correct. Counted over the same sample window as above.",
    pendingPromotions: "Promotions awaiting action",
    pendingPromotionsSub: "candidate through schema_proposed (all time)",
    pendingFetchFailed: "Could not count the promotions awaiting action",
    l2Intents: "Intents falling to L2",
    gapIntent: "intent",
    gapGenerated: "L2 generations",
    gapFallbacks: "fallbacks",
    noL2Intents: "No L2 generations in this window",
    editedSchemas: "Most-edited schemas",
    gapComponent: "component",
    gapEdits: "edits",
    gapTopFields: "most-changed fields",
    noSchemaEdits: "No schema edits in this window",
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
    opRead: "viewing fixation candidates and records (fixation.read)",
    fetchFailed: "Failed to fetch fixation data",
  },
  approvals: {
    description:
      "Governed Actions that need a human approval and were attempted without a valid token. Approving mints a short-lived token bound to the requester, the action and the exact payload; hand it to the requester, who pastes it when they retry. Derived from the lineage tail (the last 24 hours, up to 1000 approval events), so a very old request can fall out of this list.",
    empty: "No pending approvals.",
    requester: "requester",
    requesterUnknown:
      "The requester is unknown (the lineage record has no actor id), so a token cannot be bound.",
    age: (seconds) =>
      seconds < 60
        ? `${seconds}s ago`
        : seconds < 3600
          ? `${Math.floor(seconds / 60)}m ago`
          : `${Math.floor(seconds / 3600)}h ago`,
    requestCount: (count) => `requested ${count}×`,
    requestIdLabel: "requestId",
    payloadHashLabel: "payload hash",
    payloadLabel: "Recorded payload",
    payloadMismatch:
      "The recorded payload does not match the payload hash. Do not approve based on the displayed payload.",
    payloadUnverifiable:
      "The recorded payload could not be checked against the payload hash (hashing is unavailable here). Verify it elsewhere before approving.",
    windowFull: (limit) =>
      `Only the most recent ${limit} events were read, so older requests may not be shown.`,
    approveButton: "Approve",
    approveDisabledMismatch:
      "The recorded payload does not match the payload hash, so this request cannot be approved from here.",
    approveDisabledIssued:
      "A token was already issued and is still valid. Hand it to the requester, or re-issue it after it expires.",
    issuedNotice: (action) =>
      `Approval token issued for ${action}. Copy it and hand it to the requester; it is a bearer secret.`,
    tokenLabel: "Approval token",
    issuedAge: (seconds, ttlSeconds) => `issued ${seconds}s ago (TTL ${ttlSeconds}s)`,
    copyButton: "Copy",
    copied: "Copied",
    reissue: "Re-issue",
    issueFailed: (message, requestId) =>
      `Failed to issue the approval token${message != null && message !== "" ? `: ${message}` : ""}${requestId != null ? ` (requestId ${requestId})` : ""}`,
    selfApproval:
      "You cannot approve your own request. Switch to a different approver (the requester and the approver must differ).",
    notConfigured: "This host does not issue approvals (no ApprovalPort / authorizeGovernance is wired).",
    opIssue: "issuing an approval token (action.approve)",
    opRead: "viewing lineage events to find pending approvals (lineage.read)",
    fetchFailed: "Failed to fetch pending approvals",
  },
  promotions: {
    description:
      "Extract promotion candidates from the usage log of L2 (freely generated) parts. Once approved, they are registered into the Registry and the Intent catalog, and from then on the same request is served via L1 (declarative composition).",
    statusLabel: "status",
    statusAllOption: "all",
    emptyAll: (minUses) =>
      `No candidates. Ask "Show sales as a calendar heatmap" in Chat ${minUses} or more times and a candidate appears.`,
    emptyStatus: (status) => `No promotions with status "${status}".`,
    evaluateButton: "Extract candidates",
    opEvaluate: "extracting promotion candidates (promotion.evaluate)",
    opList: "viewing the promotion list (promotion.list)",
    opApprove: "approving a promotion",
    opWithdraw: "withdrawing a candidate from review",
    opUnpublish: "unpublishing a published entry",
    opReject: "rejecting a candidate",
    opPreview: "previewing a promotion candidate (promotion.preview)",
    requestChangesNotice:
      'Requested changes (changes_requested). Fix it and recover via "Resubmit and approve".',
    reApprovedNotice: (componentType, version) =>
      `Re-approved and promoted: registered ${componentType}@${version} into the Registry.`,
    promotedNotice: (componentType, version, intentName) =>
      `Promotion complete: registered ${componentType}@${version} into the Registry and added the Intent "${intentName}". Ask the same question in Chat and it becomes L1.`,
    withdrawnNotice: "Withdrawn. The candidate leaves the review queue.",
    unpublishedNotice:
      "Unpublished. The published entry is removed from the catalog and Intent; the next compose returns to L1 / fallback.",
    rejectedNotice: "Rejected the candidate",
    failedNotice: (message) => `Failed: ${message}`,
    usesSessions: (uses, sessions) => `${uses} uses / ${sessions} sessions`,
    changesRequestedBanner:
      'Changes have been requested (sent back). Fix the draft and use "Resubmit and approve" to return it to candidate, rejoining the judge → human approval → publish chain.',
    generatedHtml: (kb) => `Generated HTML source (${kb} KB)`,
    generatedWith: (kit, generatorVersion) =>
      generatorVersion != null ? `kit: ${kit} · generator: ${generatorVersion}` : `kit: ${kit}`,
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
    suggestionEmptyValue: "(empty)",
    suggestionAcknowledge: "I have reviewed the proposed schema against the preview",
    suggestionAcknowledgeRequired: "Confirm you reviewed the proposed schema before approving.",
    suggestionEvents: (names) => `Proposed events: ${names}`,
  },
};
