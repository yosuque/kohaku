import { type AdminMessages, defaultAdminMessages } from "@kohaku-ui/admin-react";
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
  /**
   * The console's own dictionary (published shape, `@kohaku-ui/admin-react`'s `AdminMessages`) plus the
   * sample-only "bump data version" demo control and the sample-only Gallery tab (not part of the published
   * package — see AGENTS.md's R6/R12 rulings). Typed as this exact intersection (not folded into a looser
   * shape) so a missing or renamed key in either EN or JA is a compile error — only 2 of roughly 50 strings
   * have an exact-value test (ui-strings.test.ts checks non-emptiness and key-shape parity only), so the type
   * is the real guard against drift.
   */
  admin: AdminMessages & {
    tabGallery: string;
    bumpButton: string;
    bumpNotice: (dataVersion: string) => string;
    /** Operation label for deniedMessage's role explanation on a 403 from the bump route. */
    opBump: string;
    /** Fallback notice when bumpDataVersion fails for a reason other than 403 (e.g. 404 — the route is not registered under JWT). */
    bumpFailed: string;
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
    ...defaultAdminMessages,
    tabGallery: "Gallery",
    bumpButton: "Simulate data update (bump)",
    bumpNotice: (v) => `dataVersion → ${v} (the next compose will be a cache MISS)`,
    opBump: "simulating a data update (admin.bumpDataVersion)",
    bumpFailed: "Failed to bump the data version (the demo admin route may not be enabled on this server)",
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
