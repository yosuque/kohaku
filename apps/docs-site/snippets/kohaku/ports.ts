/**
 * The one Port a product still writes by hand — the smallest in-memory shape that typechecks the
 * adoption-path snippets, and the same export set `kohaku scaffold ports` writes into ports.ts (a test pins
 * the two together). createKohakuHost() supplies the other three Ports (storage, authz, the LLM-backed
 * SemanticPort). A real product replaces this with its own data access (see the User guide §6).
 */
import type { DomainPort } from "@kohaku-ui/spec-core";

const ROWS = [
  { region: "japan", revenue: 120 },
  { region: "north_america", revenue: 95 },
];

export const domainPort: DomainPort = {
  async listOperations() {
    return [{ name: "sales_summary", description: "Revenue by region" }];
  },
  async invoke(op) {
    if (op !== "sales_summary") throw new Error(`unknown operation: ${op}`);
    return {
      columns: [
        { name: "region", type: "string" },
        { name: "revenue", type: "number" },
      ],
      rows: ROWS,
    };
  },
};
