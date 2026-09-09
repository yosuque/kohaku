import type { JsonObject } from "./schema/json.js";

export type ColumnType = "string" | "number" | "boolean" | "date";

export interface TabularColumn {
  key: string;
  label?: string;
  type: ColumnType;
}

/**
 * The common envelope for tabular data that data-binding returns and the renderer consumes.
 * It carries a dataVersion so a mismatch with the Spec's dataVersion (STALE_VERSION) can be detected.
 */
export interface TabularData {
  columns: TabularColumn[];
  rows: JsonObject[];
  dataVersion: string;
  total?: number;
  /**
   * The opaque cursor for the next page of server-side paging. If returned, it means "there is
   * more to come". The client does not interpret its contents and passes it verbatim to page.cursor on
   * the next resolve.
   */
  nextCursor?: string;
}

/**
 * Metadata for the "shape" of a query result. Contains no row data (the water), only column
 * information (the plumbing blueprint). Used by composer's chart-kind rules and props filling
 * (upholding the reference-passing principle: bulk data never travels through the model's context).
 */
export interface DataShape {
  columns: {
    name: string;
    type: ColumnType;
    role?: "dimension" | "measure" | "time";
  }[];
  rowCountHint?: number;
}
