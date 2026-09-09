import type { CatalogContribution } from "@kohaku-ui/spec-core";
import type { ComponentDefinition } from "../types.js";
import { actionButton } from "./action-button.js";
import { controlSelect } from "./control-select.js";
import { layoutGrid, layoutStack } from "./layout.js";
import { uiLoading } from "./loading.js";
import { overlayDialog, overlayToast } from "./overlay.js";
import { presentChart } from "./present-chart.js";
import { presentForm } from "./present-form.js";
import { presentList } from "./present-list.js";
import { presentMetric } from "./present-metric.js";
import { presentSpreadsheet } from "./present-spreadsheet.js";
import { layoutTab, layoutTabs } from "./tabs.js";
import { presentMarkdown, textHeading } from "./text.js";

/**
 * Core catalog (the portion whose maintenance the framework takes on).
 * Products contribute only their delta via CatalogContribution (a federated composition).
 */
export const coreCatalog: CatalogContribution<ComponentDefinition> = {
  components: [
    layoutStack,
    layoutGrid,
    layoutTabs,
    layoutTab,
    textHeading,
    presentMarkdown,
    presentChart,
    presentSpreadsheet,
    presentForm,
    presentMetric,
    presentList,
    actionButton,
    controlSelect,
    uiLoading,
    overlayDialog,
    overlayToast,
  ],
};

export {
  actionButton,
  controlSelect,
  layoutGrid,
  layoutStack,
  layoutTab,
  layoutTabs,
  overlayDialog,
  overlayToast,
  presentChart,
  presentForm,
  presentList,
  presentMarkdown,
  presentMetric,
  presentSpreadsheet,
  textHeading,
  uiLoading,
};
