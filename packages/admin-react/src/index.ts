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
