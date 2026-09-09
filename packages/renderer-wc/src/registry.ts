import { actionButton } from "./parts/action-button.js";
import { presentChart } from "./parts/chart.js";
import { controlSelect } from "./parts/control-select.js";
import { presentForm } from "./parts/form.js";
import { layoutGrid, layoutStack } from "./parts/layout.js";
import { presentList } from "./parts/list.js";
import { uiLoading } from "./parts/loading.js";
import { presentMetric } from "./parts/metric.js";
import { overlayDialog, overlayToast } from "./parts/overlay.js";
import { presentSpreadsheet } from "./parts/spreadsheet.js";
import { layoutTab, layoutTabs } from "./parts/tabs.js";
import { presentMarkdown, textHeading } from "./parts/text.js";
import type { PartBuilder } from "./types.js";

/**
 * DOM builder table for core-catalog parts (the counterpart to renderer-react's createCoreRegistry).
 * type → PartBuilder. <kohaku-surface> uses this table to detect unknown types and emits a placeholder if absent.
 * sandbox.html is handled not by the registry but directly by tree.ts via rt.mountSandbox (equivalent to renderSandbox).
 */
export function createCoreRenderRegistry(): Map<string, PartBuilder> {
  return new Map<string, PartBuilder>([
    ["layout.stack", layoutStack],
    ["layout.grid", layoutGrid],
    ["layout.tabs", layoutTabs],
    ["layout.tab", layoutTab],
    ["text.heading", textHeading],
    ["presentMarkdown", presentMarkdown],
    ["presentChart", presentChart],
    ["presentMetric", presentMetric],
    ["presentSpreadsheet", presentSpreadsheet],
    ["presentList", presentList],
    ["presentForm", presentForm],
    ["action.button", actionButton],
    ["control.select", controlSelect],
    ["ui.loading", uiLoading],
    ["overlay.dialog", overlayDialog],
    ["overlay.toast", overlayToast],
  ]);
}
