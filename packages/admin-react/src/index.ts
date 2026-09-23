// Governance console (lineage / analytics / promotion review / fixation) for kohaku hosts.
// Exports are added task by task; see the package README for the public surface.

export {
  type AdminContextValue,
  AdminProvider,
  type AdminProviderProps,
  useAdmin,
  useAdminNotice,
} from "./context.js";
export { useAnalyticsSummary, useFixations, useLineage, usePromotions } from "./hooks.js";
export { type AdminMessages, defaultAdminMessages } from "./messages.js";
export { AnalyticsTab } from "./tabs/AnalyticsTab.js";
export { FixationsTab } from "./tabs/FixationsTab.js";
export { LineageTab } from "./tabs/LineageTab.js";
export {
  buildDraftPayload,
  DEFAULT_QUERY_PATHS,
  type DraftForm,
  genericInitialDraft,
  type PromotionDefaults,
} from "./tabs/promotions/draft.js";
export {
  type PromotionActionKind,
  PromotionCard,
  type PromotionCardProps,
} from "./tabs/promotions/PromotionCard.js";
export {
  PromotionDraftEditor,
  type PromotionDraftEditorProps,
} from "./tabs/promotions/PromotionDraftEditor.js";
export { PromotionPreview } from "./tabs/promotions/PromotionPreview.js";
export { PROMOTION_STATUS_FILTERS, PromotionsTab } from "./tabs/promotions/PromotionsTab.js";
export { adminThemeStyle, V as adminVars } from "./theme.js";
export {
  BarRow,
  card,
  deniedMessage,
  Empty,
  ErrorBanner,
  Field,
  type NoticeKind,
  type NotifyFn,
  StatCard,
  StatusBadge,
  sectionTitle,
  selectStyle,
  smallButton,
  TextAreaField,
  TIER_COLOR,
} from "./ui.js";
