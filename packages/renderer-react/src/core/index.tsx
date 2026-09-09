import { ImplRegistry } from "../context.js";
import { ActionButton } from "./action-button.js";
import { PresentChart } from "./chart.js";
import { ControlSelect } from "./control-select.js";
import { PresentForm } from "./form.js";
import { LayoutGrid, LayoutStack } from "./layout.js";
import { UiLoading } from "./loading.js";
import { OverlayDialog, OverlayToast } from "./overlay.js";
import { PresentList } from "./present-list.js";
import { PresentMetric } from "./present-metric.js";
import { PresentSpreadsheet } from "./spreadsheet.js";
import { LayoutTab, LayoutTabs } from "./tabs.js";
import { PresentMarkdown, TextHeading } from "./text.js";

/**
 * React implementations of the core catalog components (paired with @kohaku-ui/registry's coreCatalog).
 * Both Web and the MCP Apps iframe use this same implementation, establishing pixel parity (Strategy A).
 */
export function createCoreRegistry(): ImplRegistry {
  return new ImplRegistry()
    .register("layout.stack", "1.0.0", LayoutStack)
    .register("layout.grid", "1.0.0", LayoutGrid)
    .register("layout.tabs", "1.0.0", LayoutTabs)
    .register("layout.tab", "1.0.0", LayoutTab)
    .register("text.heading", "1.0.0", TextHeading)
    .register("presentMarkdown", "1.0.0", PresentMarkdown)
    .register("presentChart", "1.1.0", PresentChart)
    .register("presentSpreadsheet", "1.0.0", PresentSpreadsheet)
    .register("presentForm", "1.2.0", PresentForm)
    .register("presentMetric", "1.0.0", PresentMetric)
    .register("presentList", "1.0.0", PresentList)
    .register("action.button", "1.0.0", ActionButton)
    .register("control.select", "1.0.0", ControlSelect)
    .register("ui.loading", "1.0.0", UiLoading)
    .register("overlay.dialog", "1.0.0", OverlayDialog)
    .register("overlay.toast", "1.0.0", OverlayToast);
}

export { ActionButton } from "./action-button.js";
export { PresentChart } from "./chart.js";
export { ControlSelect } from "./control-select.js";
export { DataStateNotice } from "./data-states.js";
export { PresentForm } from "./form.js";
export { LayoutGrid, LayoutStack } from "./layout.js";
export { UiLoading } from "./loading.js";
export { OverlayDialog, OverlayToast } from "./overlay.js";
export { PresentList } from "./present-list.js";
export { PresentMetric } from "./present-metric.js";
export { PresentSpreadsheet } from "./spreadsheet.js";
export { LayoutTab, LayoutTabs } from "./tabs.js";
export { PresentMarkdown, TextHeading } from "./text.js";
