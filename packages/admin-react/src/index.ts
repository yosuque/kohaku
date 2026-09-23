// Governance console (lineage / analytics / promotion review / fixation) for kohaku hosts.
// Public entry point: the AdminProvider/useAdmin context, the data-fetching hooks, the
// KohakuAdmin shell and its per-domain tabs, the default English UI copy, the design
// tokens, and the shared UI primitives the tabs are built from. See the package README
// for usage patterns.

export {
  type AdminContextValue,
  AdminProvider,
  type AdminProviderProps,
  useAdmin,
  useAdminNotice,
} from "./context.js";
export { useAnalyticsSummary, useFixations, useLineage, usePromotions } from "./hooks.js";
export {
  type AdminExtraTab,
  type AdminTabKey,
  KohakuAdmin,
  type KohakuAdminProps,
} from "./KohakuAdmin.js";
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
