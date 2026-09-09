import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  FixationRecord,
  JsonObject,
  LineageEventRecord,
  PromotionState,
  SemanticPort,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";

export const catalog = resolveCatalog(coreCatalog);

export const REF = "query://sales/summary?fy=2026&groupBy=region&q=3";

/** A deterministic SemanticPort for tests (a minimal model of the sales domain) */
export function makeSemantic(): SemanticPort {
  return {
    async normalize(input) {
      if (input.kind === "nl") {
        return {
          canonical: "sales.quarterly_summary",
          params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
          hash: "",
        };
      }
      const params = { ...(input.current?.params ?? {}), ...input.params } as JsonObject;
      return {
        canonical: input.current?.canonical ?? "sales.quarterly_summary",
        params,
        hash: "",
      };
    },
    async resolveQuery(intent) {
      const p = intent.params as { fiscalYear?: number; groupBy?: string; quarter?: number };
      return {
        uri: `query://sales/summary?fy=${p.fiscalYear ?? 2026}&groupBy=${p.groupBy ?? "region"}&q=${p.quarter ?? 3}`,
      };
    },
    async dataVersion() {
      return "sales@seed-1";
    },
    async describeShape() {
      return {
        columns: [
          { name: "region", type: "string", role: "dimension" },
          { name: "revenue", type: "number", role: "measure" },
          { name: "units", type: "number", role: "measure" },
        ],
        rowCountHint: 4,
      };
    },
  };
}

/**
 * A multi-handle SemanticPort for tests (returns a different dataVersion per reference).
 * Used to verify the contract that SemanticPort.dataVersion(handle) allows a per-handle version.
 */
export function makeMultiSemantic(handles: readonly { uri: string; version: string }[]): SemanticPort {
  const versionByUri = new Map(handles.map((h) => [h.uri, h.version]));
  return {
    async normalize(input) {
      const params =
        input.kind === "nl"
          ? { fiscalYear: 2026, quarter: 3, groupBy: "region" }
          : ({ ...(input.current?.params ?? {}), ...input.params } as JsonObject);
      return { canonical: "sales.multi_ref", params: params as JsonObject, hash: "" };
    },
    async resolveQuery() {
      return handles.map((h) => ({ uri: h.uri }));
    },
    async dataVersion(handle) {
      return versionByUri.get(handle.uri) ?? "unknown";
    },
  };
}

export function makeStorage(): StoragePort & { specCache: Map<string, UISpec> } {
  const specCache = new Map<string, UISpec>();
  const lineage: LineageEventRecord[] = [];
  const promotions = new Map<string, PromotionState>();
  const fixations = new Map<string, FixationRecord>();
  return {
    specCache,
    async getSpecCache(key) {
      return specCache.get(key) ?? null;
    },
    async putSpecCache(key, spec) {
      specCache.set(key, spec);
    },
    async appendLineage(event) {
      lineage.push(event);
    },
    async listLineage() {
      return lineage;
    },
    async getPromotionState(id) {
      return promotions.get(id) ?? null;
    },
    async putPromotionState(state) {
      promotions.set(state.artifactId, state);
    },
    async listPromotionStates() {
      return [...promotions.values()];
    },
    async getFixation(hash) {
      return fixations.get(hash) ?? null;
    },
    async putFixation(record) {
      fixations.set(record.intentHash, record);
    },
    async listFixations() {
      return [...fixations.values()];
    },
  };
}

/** A valid draft in the "raw" form of the L1 generation schema (null-filled, payload pairs) */
export function goodRawDraft(ref: string = REF): unknown {
  return {
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: null },
        children: ["h", "c", "t"],
      },
      { id: "h", type: "text.heading", props: { level: 2, text: "FY2026 Q3 Sales (by region)" } },
      {
        id: "c",
        type: "presentChart",
        props: { kind: "bar", x: "region", y: "revenue", series: null, stacked: null, title: null },
        children: null,
        data: { $ref: ref },
      },
      {
        id: "t",
        type: "presentSpreadsheet",
        props: { editable: false, columns: null, sortBy: null, pageSize: null },
        children: null,
        data: { $ref: ref },
      },
    ],
    events: [
      {
        on: "t.rowClick",
        emit: "intent.patch",
        payload: [{ key: "drilldown", value: "$row.region" }],
      },
    ],
  };
}
