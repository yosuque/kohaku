// @kohaku-ui/renderer-core — the framework-free / DOM-free shared renderer core.
// spec-core → {registry, data-binding} → renderer-core → {renderer-react, renderer-wc}.
// This is the source of truth for environment-neutral logic, and both renderers
// consume the same core.

// a11y / theme
export { FOCUSABLE_SELECTOR, isActivationKey, visuallyHiddenStyle } from "./a11y.js";
// Event governance / write decisions / row templates
export {
  type EmitResolution,
  hasDeclaredEvent,
  resolveEmit,
  resolvePayloadTemplate,
  type SurfaceEvent,
} from "./control/emit.js";
export { focusTrapTarget } from "./control/focus-trap.js";
export {
  type ActionPhase,
  type InvokeTarget,
  type RunInvokeTargetDeps,
  resolveActionName,
  resolveInvokeTarget,
  runInvokeTarget,
} from "./control/invoke.js";
export { resolveRowProps, substituteRow } from "./control/row-template.js";
export { boundStateKey, normalizeSelectOptions, type SelectOption } from "./control/select-options.js";
export { type DesignKit, defaultDesignKit, PARTS_STATE_CSS } from "./design-kit.js";
// Messages
export { DEFAULT_LOCALE, DEFAULT_MESSAGES, type RendererMessages } from "./messages.js";
export { type ActionButtonTokens, actionButtonStyle } from "./presenters/action-button.js";
export {
  A11Y_TABLE_ROW_CAP,
  CHART_TOKEN_KEYS,
  type ChartColors,
  type ChartConfig,
  type ChartReferenceLine,
  chartCaptionStyle,
  chartPointRow,
  chartTableStyle,
  DEFAULT_CHART_PALETTE,
  describeChartDataTable,
  type PreparedChart,
  prepareRows,
  resolveChartConfig,
} from "./presenters/chart.js";
export {
  type DataStateView,
  dataStateNoticeStyle,
  loadingStyle,
  renderFailureNoticeStyle,
  resolveDataStateView,
} from "./presenters/data-state.js";
export {
  asStringArray,
  buildDefaults,
  type ControlDescriptor,
  coerceFieldValues,
  constraintAttrs,
  controlSelectStyle,
  describeControl,
  describedByOf,
  describeFieldRow,
  type FieldDef,
  type FieldRowMeta,
  type FieldViolation,
  type FieldViolationRule,
  type FormSubmitPlan,
  fieldRowStyle,
  focusFieldSelectors,
  formControlBaseStyle,
  formFillKey,
  formRootStyle,
  formSubmitButtonStyle,
  mergeRow,
  normalizeOptions,
  planFormSubmit,
  validateFormValues,
} from "./presenters/form.js";
export { gapFor, HARD_ROW_CAP } from "./presenters/layout.js";
export { listEmptyStyle } from "./presenters/list-style.js";
export {
  type MarkdownBlock,
  type MarkdownInline,
  parseMarkdownBlocks,
  parseMarkdownInline,
} from "./presenters/markdown.js";
// Pure-logic presenters for each part (no markup)
export {
  computeDelta,
  formatNumber,
  formatValue,
  type MetricDelta,
  type MetricFormat,
  type MetricView,
  type MetricViewTokens,
  metricCardStyle,
  metricDeltaStyle,
  metricLabelStyle,
  metricValueStyle,
  resolveMetricView,
} from "./presenters/metric.js";
export {
  dialogBoxStyle,
  dialogCloseButtonStyle,
  dialogDescriptionStyle,
  dialogHeaderStyle,
  dialogOverlayStyle,
  dialogTitleStyle,
  type ToastToneColors,
  toastDismissButtonStyle,
  toastRole,
  toastStyle,
  toastToneColors,
} from "./presenters/overlay.js";
export {
  type SandboxNoticeTone,
  sandboxArtifactMissingText,
  sandboxBadgeDescriptionStyle,
  sandboxBadgeDescriptionText,
  sandboxBadgePillStyle,
  sandboxBadgeRowStyle,
  sandboxBadgeText,
  sandboxBridgeMissingText,
  sandboxErrorNoticeText,
  sandboxLoadingNoticeText,
  sandboxNoticeBaseStyle,
  sandboxNoticeToneStyle,
} from "./presenters/sandbox-chrome.js";
export {
  applyLocalView,
  buildResolveOptions,
  type CellCoercion,
  type CellEditPlan,
  cellDraft,
  coerceCellInput,
  commitCellEdit,
  compareRows,
  describeSortHeader,
  effectiveRows,
  formatCell,
  localFooterTotal,
  nextSortState,
  planCellEdit,
  type RowsWorkingCopy,
  resolveColumns,
  rowKey,
  type SortHeaderDescriptor,
  type SortState,
  SPREADSHEET_HARD_ROW_CAP,
  type SpreadsheetCellEdit,
  type SpreadsheetCellEditRuntime,
  type SpreadsheetRowRuntime,
  type SpreadsheetSortRuntime,
  type SpreadsheetTokens,
  sortRows,
  spreadsheetCellEditButtonStyle,
  spreadsheetCellEditInputStyle,
  spreadsheetFooterBarStyle,
  spreadsheetFooterTotalStyle,
  spreadsheetPagerButtonStyle,
  spreadsheetSortButtonStyle,
  spreadsheetTdStyle,
  spreadsheetThStyle,
} from "./presenters/spreadsheet.js";
export {
  describeTab,
  nextTabIndex,
  resolveTabs,
  type TabButtonTokens,
  type TabIds,
  type TabMeta,
  tabButtonStyle,
} from "./presenters/tabs.js";
export {
  textBodyStyle,
  textCodeStyle,
  textHeadingStyle,
  textListStyle,
  textPreStyle,
  textSubheadingStyle,
} from "./presenters/text-style.js";
export {
  createSpreadsheetRemoteController,
  type SpreadsheetRemoteController,
  type SpreadsheetRemoteControllerDeps,
  type SpreadsheetRemoteSnapshot,
} from "./spreadsheet-remote-controller.js";
export {
  type BoundData,
  type BoundDataController,
  type BoundDataControllerDeps,
  type BoundDataMessages,
  createBoundDataController,
  expectedVersionFor,
} from "./stores/bound-data-controller.js";
// Stores / controllers
export {
  createDataInvalidationBus,
  type DataInvalidationBus,
  type DataInvalidationEvent,
  NOOP_INVALIDATION_BUS,
} from "./stores/invalidation-bus.js";
export {
  createSpecStateStore,
  type SpecStateReadable,
  type SpecStateStore,
} from "./stores/spec-state-store.js";
export {
  DEFAULT_SIZING,
  defaultDarkTheme,
  defaultLightTheme,
  HOST_STYLE_VARIABLE_MAP,
  type NonColorTokens,
  resolveSizing,
  resolveToken,
  type SizingTokens,
  sandboxThemeCss,
  themeFromHostStyles,
  themeTokensToCssVars,
} from "./theme.js";
