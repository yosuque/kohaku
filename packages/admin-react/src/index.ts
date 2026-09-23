// Governance console (lineage / analytics / promotion review / fixation) for kohaku hosts.
// Public entry point: the AdminProvider/useAdmin context, the data-fetching hooks, the
// KohakuAdmin shell and its per-domain tabs, the default English UI copy, and the design
// tokens — the domain API only. The generic UI primitives the tabs are built from live on
// the separate `@kohaku-ui/admin-react/ui` subpath. See the package README for usage patterns.

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
export { SuggestionPanel } from "./tabs/promotions/SuggestionPanel.js";
export {
  diffAgainstSuggestion,
  draftFormFromSuggestion,
  type SuggestionField,
  type SuggestionFieldDiff,
} from "./tabs/promotions/suggestion.js";
export { adminThemeStyle, V as adminVars } from "./theme.js";
// The generic UI primitives (card, Field, Empty, etc.) live on the `@kohaku-ui/admin-react/ui` subpath, not
// here — the root carries only the domain API. `NoticeKind` / `NotifyFn` are the exception: they type
// AdminProvider's `onNotice` prop, so they stay re-exported from the root even though they're defined in ui.tsx.
export type { NoticeKind, NotifyFn } from "./ui.js";
