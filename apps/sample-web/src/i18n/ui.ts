import { getLang, type Lang, useLang } from "./lang.js";

/**
 * Typed EN/JA dictionary for the page chrome (nav, chat, dashboard, admin). The Spec-rendered
 * content is localized separately (renderer messages + server-side output language); this file
 * covers only strings authored by the web app itself.
 *
 * Untranslated by policy (technical identifiers): the "LLM:" health prefix, provenance chips
 * (cache:HIT / intent:<hash> / model: / dataVer: / fallback), tenant and role IDs, status codes
 * (candidate / published / …), and StatCard metric names (view.composed etc.).
 *
 * `UIStrings` is a single interface, so a missing JA key is a compile error. Parameterized
 * messages are functions. Access via useT() (React, re-renders on toggle) or t() (non-React).
 */
export interface UIStrings {
  chrome: {
    headerSubtitle: string;
    navDashboard: string;
    navChat: string;
    navAdmin: string;
    apiNotConnected: string;
    langToggleAria: string;
    langToggleTitleToEn: string;
    langToggleTitleToJa: string;
    themeToggleAria: string;
    themeTitleToLight: string;
    themeTitleToDark: string;
    themeLight: string;
    themeDark: string;
    roleLabel: string;
    roleSwitchAria: string;
    roleOptions: { admin: string; reviewer: string; viewer: string };
    tenantLabel: string;
    tenantSwitchAria: string;
    tenantDefaultLabel: string;
    specJsonSummary: string;
    copyIntentHashTitle: string;
  };
  chat: {
    empty1: string;
    empty2: string;
    suggestions: string[];
    placeholder: string;
    send: string;
    normalizing: string;
    composingSkeleton: string;
    composing: string;
    recomposing: string;
    compositionFailed: string;
    errorFallback: string;
    openInDashboard: string;
    viaLlm: string;
    intentHashTitle: string;
  };
  dashboard: {
    viewSection: string;
    filtersSection: string;
    composing: string;
    loading: string;
    writeFailed: (action: string, message: string) => string;
    writeCompleted: (action: string, dataVersion: string, notes: number | null) => string;
    /** Toggle for SpecView's opt-in enableViewTransitions prop (demo only — see SpecView.tsx). */
    viewTransitionsToggle: string;
  };
  admin: {
    tabLineage: string;
    tabAnalytics: string;
    tabPromotions: string;
    tabFixations: string;
    tabGallery: string;
    bumpButton: string;
    bumpNotice: (dataVersion: string) => string;
    /** Operation label for deniedMessage's role explanation on a 403 from the bump route. */
    opBump: string;
    /** Fallback notice when bumpDataVersion fails for a reason other than 403 (e.g. 404 — the route is not registered under JWT). */
    bumpFailed: string;
    refresh: string;
    deniedMessage: (code: string, operation: string) => string;
    emptyDefault: string;
    lineage: {
      description: string;
      empty: string;
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
    };
    fixations: {
      description: string;
      candidatesTitle: string;
      /** minUses is the fixation-nomination threshold, sourced from GET /analytics/summary's promotionPolicy (M7: single source, not a duplicated literal). */
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
      /** minUses is the promotion-nomination threshold, sourced from GET /analytics/summary's promotionPolicy (M7: single source, not a duplicated literal). */
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
    };
    gallery: {
      description: string;
      kitToggle: string;
      pasteLabel: string;
      pastePlaceholder: string;
    };
  };
}

const EN: UIStrings = {
  chrome: {
    headerSubtitle: "sample — Sales Analytics",
    navDashboard: "Dashboard",
    navChat: "Chat",
    navAdmin: "Admin",
    apiNotConnected: "API not connected",
    langToggleAria: "Toggle UI language (English / Japanese)",
    langToggleTitleToEn: "Switch to English",
    langToggleTitleToJa: "Switch to Japanese",
    themeToggleAria: "Toggle theme (light/dark)",
    themeTitleToLight: "Switch to light",
    themeTitleToDark: "Switch to dark",
    themeLight: "Light",
    themeDark: "Dark",
    roleLabel: "Role",
    roleSwitchAria: "Switch role",
    roleOptions: {
      admin: "admin (full access)",
      reviewer: "reviewer (promotion)",
      viewer: "viewer (read-only)",
    },
    tenantLabel: "Tenant",
    tenantSwitchAria: "Switch tenant",
    tenantDefaultLabel: "default (unspecified)",
    specJsonSummary: "Show Spec JSON (data is $ref references only — no values here)",
    copyIntentHashTitle: "Copy the intent hash (confirm it matches between the GUI and chat)",
  },
  chat: {
    empty1: "Ask about the sales data in natural language.",
    empty2:
      "It converges on the same normalized Intent as the GUI facets, yielding the same Spec and the same rendering.",
    suggestions: [
      "Regional sales for FY2026 Q3 as a chart",
      "Monthly sales trend",
      "Top 5 products by sales",
      "How is Q2 target attainment?",
      "Show sales as a calendar heatmap",
    ],
    placeholder: "e.g. Regional sales for FY2026 Q3 as a chart",
    send: "Send",
    normalizing: "Converting the question into a normalized Intent…",
    composingSkeleton: "Composing the UI Spec… showing a skeleton first",
    composing: "Composing the UI Spec…",
    recomposing: "Re-composing…",
    compositionFailed: "Composition failed",
    errorFallback: "Error",
    openInDashboard: "Open in dashboard →",
    viaLlm: "via LLM",
    intentHashTitle:
      "Hash of the normalized Intent (matches when the same question is asked on the Dashboard)",
  },
  dashboard: {
    viewSection: "View",
    filtersSection: "Filters",
    composing: "Composing…",
    loading: "Loading…",
    writeFailed: (action, message) => `Write "${action}" failed: ${message}`,
    writeCompleted: (action, dataVersion, notes) =>
      `Write "${action}" completed. dataVersion → ${dataVersion}` +
      (notes != null ? ` / ${notes} note(s)` : "") +
      " (the table was re-fetched with no Spec replacement)",
    viewTransitionsToggle: "View transitions",
  },
  admin: {
    tabLineage: "View Lineage",
    tabAnalytics: "Analytics",
    tabPromotions: "Promotion Review (L2→L1)",
    tabFixations: "Fixation (L1→L0)",
    tabGallery: "Gallery",
    bumpButton: "Simulate data update (bump)",
    bumpNotice: (v) => `dataVersion → ${v} (the next compose will be a cache MISS)`,
    opBump: "simulating a data update (admin.bumpDataVersion)",
    bumpFailed: "Failed to bump the data version (the demo admin route may not be enabled on this server)",
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
    },
    gallery: {
      description: "Canned fixture data; this tab never calls the API.",
      kitToggle: "Inject the default design kit",
      pasteLabel: "L2 artifact HTML",
      pastePlaceholder:
        "Paste a generated L2 artifact (from the Promotion Review (L2→L1) tab's generated HTML) to preview it with the current theme and kit",
    },
  },
};

const JA: UIStrings = {
  chrome: {
    headerSubtitle: "サンプル — 売上分析",
    navDashboard: "ダッシュボード",
    navChat: "チャット",
    navAdmin: "管理",
    apiNotConnected: "API 未接続",
    langToggleAria: "表示言語を切り替え(英語 / 日本語)",
    langToggleTitleToEn: "英語に切り替え",
    langToggleTitleToJa: "日本語に切り替え",
    themeToggleAria: "テーマを切り替え(ライト / ダーク)",
    themeTitleToLight: "ライトに切り替え",
    themeTitleToDark: "ダークに切り替え",
    themeLight: "ライト",
    themeDark: "ダーク",
    roleLabel: "ロール",
    roleSwitchAria: "ロールを切り替え",
    roleOptions: {
      admin: "admin(フルアクセス)",
      reviewer: "reviewer(昇格レビュー)",
      viewer: "viewer(読み取り専用)",
    },
    tenantLabel: "テナント",
    tenantSwitchAria: "テナントを切り替え",
    tenantDefaultLabel: "default(未指定)",
    specJsonSummary: "Spec JSON を表示(data は $ref 参照のみ — 値は含まれません)",
    copyIntentHashTitle: "intent ハッシュをコピー(GUI とチャットで一致することを確認)",
  },
  chat: {
    empty1: "売上データについて自然言語で質問してください。",
    empty2: "GUI ファセットと同じ正規化 Intent に収束し、同じ Spec・同じ描画になります。",
    // Aligned with the JA NL examples in sample-api's catalog.ts (keeps normalization deterministic-friendly).
    suggestions: [
      "2026年度Q3の地域別売上をグラフで",
      "売上の月次推移",
      "製品別売上トップ5",
      "Q2の目標達成状況は?",
      "売上をカレンダーヒートマップで",
    ],
    placeholder: "例: 2026年度Q3の地域別売上をグラフで",
    send: "送信",
    normalizing: "質問を正規化 Intent に変換中…",
    composingSkeleton: "UI Spec を構成中… まずスケルトンを表示します",
    composing: "UI Spec を構成中…",
    recomposing: "再構成中…",
    compositionFailed: "構成に失敗しました",
    errorFallback: "エラー",
    openInDashboard: "ダッシュボードで開く →",
    viaLlm: "LLM 経由",
    intentHashTitle: "正規化 Intent のハッシュ(ダッシュボードで同じ質問をすると一致します)",
  },
  dashboard: {
    viewSection: "ビュー",
    filtersSection: "フィルター",
    composing: "構成中…",
    loading: "読み込み中…",
    writeFailed: (action, message) => `書き込み「${action}」に失敗しました: ${message}`,
    writeCompleted: (action, dataVersion, notes) =>
      `書き込み「${action}」が完了しました。dataVersion → ${dataVersion}` +
      (notes != null ? ` / メモ ${notes} 件` : "") +
      "(Spec の差し替えなしで表を再取得しました)",
    viewTransitionsToggle: "ビュー遷移アニメーション",
  },
  admin: {
    tabLineage: "View Lineage",
    tabAnalytics: "アナリティクス",
    tabPromotions: "昇格レビュー(L2→L1)",
    tabFixations: "固定化(L1→L0)",
    tabGallery: "ギャラリー",
    bumpButton: "データ更新をシミュレート(bump)",
    bumpNotice: (v) => `dataVersion → ${v}(次の compose はキャッシュ MISS になります)`,
    opBump: "データ更新のシミュレート (admin.bumpDataVersion)",
    bumpFailed:
      "データバージョンの更新に失敗しました(このサーバーではデモ用の管理ルートが無効になっている可能性があります)",
    refresh: "更新",
    deniedMessage: (code, operation) =>
      `権限がありません(${code}): 現在のロールでは「${operation}」を実行できません。ヘッダー右上のロールを admin / reviewer に切り替えてください。`,
    emptyDefault: "データなし",
    lineage: {
      description:
        "UI Spec のイベントソーシング — web / chat サーフェス間で同じ intentHash が並ぶ行が「同じ要求 → 同じ描画」の監査証跡です",
      empty: "イベントはありません(ダッシュボード / チャットを使うと記録されます)",
    },
    analytics: {
      description: (limit, truncated, events) =>
        `フォールバック率・ティア分布・レイテンシの概況。直近 ${limit} イベントを集計(既定 200)` +
        (truncated ? "(ウィンドウ上限に到達 — それより古いイベントは対象外)" : "") +
        `。対象 ${events} イベント。`,
      loading: "読み込み中…(アクティビティがまだ無い場合、サマリーは空です)",
      fetchFailed: "アナリティクスサマリーの取得に失敗しました",
      opRead: "利用状況アナリティクスの閲覧 (analytics.read)",
      fallbackRateLabel: "フォールバック率",
      latencyLabel: "レイテンシ p95",
      fixationsLabel: "固定化数",
      eventsSub: (n) => `${n} イベント`,
      unfixatedSub: (n) => `解除 ${n}`,
      tierDistribution: "ティア分布",
      cacheBreakdown: "キャッシュ内訳",
      fallbackBreakdown: "フォールバック内訳(種別)",
      noFallbacks: "フォールバックなし",
      topIntents: "上位 Intent",
      noComposeRecords: "compose 記録はまだありません",
      promotionLifecycle: "昇格ライフサイクル(イベント数)",
    },
    fixations: {
      description:
        "頻出で構造が安定した L1 Intent を固定化すると、LLM を一切通らない L0 パスで配信されます(構造は固定・データは $ref 参照渡しで常に最新)。",
      candidatesTitle: "固定化候補",
      candidatesEmpty: (minUses) =>
        `候補はありません。L1 ビュー(例: 推移)が ${minUses} 回以上表示されると現れます。`,
      usesStability: (uses, pct) => `${uses} 回使用 / 安定度 ${pct}%`,
      fixateButton: "L0 に固定化",
      fixatedNotice: (canonical) => `固定化しました: ${canonical}(以後 L0 / cache:FIXATED)`,
      fixateFailed: "固定化に失敗しました",
      opApprove: "L0 固定化 (fixation.approve)",
      fixatedTitle: "固定化済み",
      none: "なし",
      removeButton: "解除",
      removeFailed: "固定化の解除に失敗しました",
      opRemove: "固定化の解除 (fixation.remove)",
    },
    promotions: {
      description:
        "L2(自由生成)パーツの利用ログから昇格候補を抽出します。承認すると Registry と Intent カタログに登録され、以後同じ要求は L1(宣言的構成)で配信されます。",
      statusLabel: "status",
      statusAllOption: "all(候補を抽出)",
      emptyAll: (minUses) =>
        `候補はありません。チャットで「売上をカレンダーヒートマップで」を ${minUses} 回以上尋ねると候補が現れます。`,
      emptyStatus: (status) => `ステータス「${status}」の昇格はありません。`,
      opEvaluate: "昇格候補の抽出 (promotion.evaluate)",
      opList: "昇格一覧の閲覧 (promotion.list)",
      opApprove: "昇格の承認",
      opWithdraw: "公開の取り下げ",
      opReject: "候補の却下",
      opPreview: "昇格候補のプレビュー (promotion.preview)",
      requestChangesNotice:
        "修正依頼(changes_requested)を送りました。修正のうえ「再提出して承認」で復帰できます。",
      reApprovedNotice: (componentType, version) =>
        `再承認して昇格しました: ${componentType}@${version} を Registry に登録しました。`,
      promotedNotice: (componentType, version, intentName) =>
        `昇格が完了しました: ${componentType}@${version} を Registry に登録し、Intent「${intentName}」を追加しました。チャットで同じ質問をすると L1 になります。`,
      withdrawnNotice:
        "取り下げました。公開エントリはカタログと Intent から削除され、次の compose は L1 / フォールバックに戻ります。",
      rejectedNotice: "候補を却下しました",
      failedNotice: (message) => `失敗しました: ${message}`,
      usesSessions: (uses, sessions) => `${uses} 回使用 / ${sessions} セッション`,
      changesRequestedBanner:
        "修正依頼(差し戻し)されています。ドラフトを修正して「再提出して承認」で candidate に戻すと、judge → 人手承認 → publish の連鎖に再合流します。",
      generatedHtml: (kb) => `生成 HTML ソース(${kb} KB)`,
      descriptionFieldLabel: "description(LLM の選定ガイダンス)",
      schemaDetailsSummary: "スキーマとデータ配線(詳細)",
      paramsJsonSchemaLabel: "paramsJsonSchema(props / intent params の JSON Schema。空 = プロダクト既定)",
      queryPathLabel: "queryTemplate.path(空 = 既定の trend 固定配線)",
      queryPathDefaultOption: "(既定 / trend 固定)",
      fixedParamsLabel: "fixedParams(固定クエリパラメータの JSON)",
      paramMapLabel: "paramMap(intent param → query param の対応 JSON)",
      invalidJson: (label, message) => `${label} の JSON が不正です: ${message}`,
      approveResubmitButton: "↻ 再提出して承認(修正を適用 → publish)",
      approveButton: "✓ 承認して登録(judge → 人手承認 → publish)",
      requestChangesButton: "修正依頼(差し戻し)",
      withdrawButton: "取り下げ",
      rejectButton: "却下",
      unpublishButton: "公開取り下げ",
      previewButton: "▶ プレビュー(隔離 iframe で実描画)",
      previewLoading: "読み込み中…",
      closePreview: "プレビューを閉じる",
      previewNoRefWarning:
        "この候補にはデータ参照が記録されていないため、データ取得はエラーになります(見た目の骨格のみ確認できます)。",
      previewFetchFailed: (message) => `プレビューを取得できませんでした: ${message}`,
      previewMalformed: "プレビュー応答が不正です",
    },
    gallery: {
      description: "固定のフィクスチャデータを使用しており、このタブは API を呼び出しません。",
      kitToggle: "既定デザインキットを注入する",
      pasteLabel: "L2 アーティファクト HTML",
      pastePlaceholder:
        "生成された L2 アーティファクト(昇格レビュー(L2→L1)タブの生成 HTML)を貼り付けると、現在のテーマとキットでプレビューします",
    },
  },
};

export const UI: Record<Lang, UIStrings> = { en: EN, ja: JA };

/** React hook: the current dictionary; re-renders on language toggle. */
export function useT(): UIStrings {
  return UI[useLang().lang];
}

/** Non-React accessor (event callbacks, module helpers): the dictionary at call time. */
export function t(): UIStrings {
  return UI[getLang()];
}
