import type { RendererMessages } from "@kohaku-ui/renderer-react";

/**
 * Japanese UI strings for the demo. The library default (DEFAULT_MESSAGES) is English;
 * the sample injects Japanese via the i18n override mechanism (RendererProvider.messages).
 */
export const JA_MESSAGES: RendererMessages = {
  formSubmit: "送信",
  formSubmitted: "送信しました",
  formSelectPlaceholder: "選択してください",
  formRequired: (label) => `${label}は必須です`,
  formMinLength: (label, min) => `${label}は${min}文字以上で入力してください`,
  formMaxLength: (label, max) => `${label}は${max}文字以内で入力してください`,
  formPattern: (label) => `${label}の形式が正しくありません`,
  formMin: (label, min) => `${label}は${min}以上で入力してください`,
  formMax: (label, max) => `${label}は${max}以下で入力してください`,
  formErrorSummary: (count) => `入力内容に ${count} 件の問題があります`,
  dataLoading: "データを読み込み中…",
  dataStale: "データが更新されています。表示を更新してください。",
  bindingMissing: "binding client が設定されていません",
  spreadsheetTotal: (total, shown) => `全 ${total} 行中 ${shown} 行を表示`,
  spreadsheetNextPage: "次へ",
  spreadsheetFirstPage: "最初のページ",
  spreadsheetEditCell: (column) => `${column}を編集`,
  chartDefaultLabel: (kind) => `${kind} チャート`,
  nodeRenderFailed: (type, id) => `部品の描画に失敗しました(${type} / ${id})`,
  metricDelta: (delta, direction) =>
    direction === "up" ? `${delta}(増加)` : direction === "down" ? `${delta}(減少)` : delta,
  metricAriaLabel: (label, value, delta) =>
    delta != null ? `${label}: ${value}、前期比 ${delta}` : `${label}: ${value}`,
  sandboxBadgeLabel: "L2 サンドボックス",
  sandboxBadgeDescription:
    "自由生成された HTML を隔離された iframe 内で実行しています(通信は遮断、データはブリッジ経由の参照渡し)",
  sandboxLoading: "サンドボックスを起動しています…",
  sandboxErrorFallback: "サンドボックス内でエラーが発生しました",
  sandboxArtifactMissing: "サンドボックスの部品がありません(インライン HTML が必要です)",
  sandboxBridgeMissing: (type) => `L2 部品(${type})の描画にはサンドボックスブリッジの注入が必要です`,
};
