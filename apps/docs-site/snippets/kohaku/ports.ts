/**
 * The four Ports a product implements — the smallest in-memory shape that typechecks the adoption-path
 * snippets. A real product replaces every one of these (see the User guide §6); the sample's implementations
 * under apps/sample-api/src/ports are the didactic reference.
 */
import type {
  AuthzPort,
  DomainPort,
  FixationRecord,
  IntentInput,
  LineageEventRecord,
  PromotionState,
  QueryHandle,
  SemanticPort,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";

const ROWS = [
  { region: "japan", revenue: 120 },
  { region: "north_america", revenue: 95 },
];

export const domain: DomainPort = {
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

export const semantic: SemanticPort = {
  async normalize(input): Promise<IntentInput> {
    if (input.kind === "gui") return { canonical: input.action, params: input.params };
    return { canonical: "sales.summary", params: {} };
  },
  async resolveQuery(): Promise<QueryHandle[]> {
    return [{ uri: "query://my-product/sales_summary" }];
  },
  async dataVersion() {
    return "my-product@1";
  },
};

export const authz: AuthzPort = {
  async issueCapability(principal, scopes) {
    return Buffer.from(JSON.stringify({ sub: principal.id, scopes })).toString("base64url");
  },
  /**
   * STUB — trusts the token's contents unconditionally: it decodes and reads the claims but checks
   * neither an integrity signature nor an expiry, so any caller can forge a token for any principal and
   * any scope. Copy `apps/sample-api/src/ports/authz-port.ts` instead: HMAC-SHA256 signature, a
   * constant-time comparison (`timingSafeEqual`), and an `exp` check before any claim is trusted.
   */
  async verify(token, req) {
    const claims = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      sub: string;
      scopes: { kind: string; ref: string }[];
    };
    const ok = claims.scopes.some((s) => s.kind === req.kind && s.ref === req.ref);
    return ok ? { ok, principal: { id: claims.sub } } : { ok, reason: "scope does not cover the request" };
  },
};

const specs = new Map<string, UISpec>();
const events: LineageEventRecord[] = [];
const promotions = new Map<string, PromotionState>();
const fixations = new Map<string, FixationRecord>();

export const storage: StoragePort = {
  async getSpecCache(key) {
    return specs.get(key) ?? null;
  },
  async putSpecCache(key, spec) {
    specs.set(key, spec);
  },
  async appendLineage(event) {
    events.push(event);
  },
  async listLineage(filter) {
    return events
      .filter((e) => filter?.type == null || filter.type.includes(e.type))
      .slice(-(filter?.limit ?? events.length));
  },
  async getPromotionState(artifactId) {
    return promotions.get(artifactId) ?? null;
  },
  async putPromotionState(state) {
    promotions.set(state.artifactId, state);
  },
  async listPromotionStates() {
    return [...promotions.values()];
  },
  async getFixation(intentHash) {
    return fixations.get(intentHash) ?? null;
  },
  async putFixation(record) {
    fixations.set(record.intentHash, record);
  },
  async listFixations() {
    return [...fixations.values()];
  },
  async deleteFixation(intentHash) {
    fixations.delete(intentHash);
  },
};
