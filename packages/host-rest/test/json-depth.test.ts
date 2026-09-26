import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SemanticPort, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

/**
 * Regression coverage for the deep-nesting recursion-DoS fix (spec-core's JsonObjectSchema / JsonValueSchema
 * depth guard, plus routes/shared.ts's parseBody whole-body depth check). Complements
 * schemas.test.ts's boundary coverage (depth 32 accepted / 33 rejected) with the depths from the original
 * report (5000 / 100000): before the fix, these overflowed the stack (an uncaught RangeError, surfaced to the
 * client as a raw 500) instead of failing schema validation with a clean 400.
 *
 * The malicious payload is built as a raw JSON *string* (not a JS object passed through JSON.stringify), the
 * same way a real request body would arrive over the wire, and nests via arrays (`[[[...]]]`, 2 bytes per
 * level) rather than objects so a 100000-level payload stays a few hundred KB -- comfortably under
 * DEFAULT_MAX_BODY_BYTES (1 MiB) -- and the size cap (bodyLimit) never masks the depth check under test.
 */
function deeplyNestedArrayJson(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

const catalog = resolveCatalog(coreCatalog);

function stubSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      return { uri: "query://sales/summary?fy=2026" };
    },
    async dataVersion() {
      return "sales@v1";
    },
  };
}

function stubStorage(): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

function allowAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true, principal: { id: "u", roles: ["user"] } };
    },
  };
}

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return {};
  },
};

function makeDeps(): KohakuHostDeps {
  const compose: ComposeContext = {
    catalog,
    semantic: stubSemantic(),
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: {},
  };
  return { compose, domain, authz: allowAuthz(), querySource: "sales" };
}

async function postJson(
  deps: KohakuHostDeps,
  path: string,
  rawJsonBody: string,
): Promise<{ status: number; body: unknown }> {
  const app = createKohakuRoutes(deps);
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawJsonBody,
  });
  return { status: res.status, body: await res.json() };
}

describe.each([5000, 100_000])("a %i-level-deep payload (no RangeError, a clean 400)", (depth) => {
  const deepArray = deeplyNestedArrayJson(depth);

  it("/compose: rejected with 400 BAD_REQUEST, not a 500 / thrown RangeError", async () => {
    const result = await postJson(
      makeDeps(),
      "/compose",
      `{"intent":{"canonical":"sales.trend","params":{"a":${deepArray}}}}`,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("/events: rejected with 400 BAD_REQUEST, not a 500 / thrown RangeError", async () => {
    const result = await postJson(
      makeDeps(),
      "/events",
      `{"intent":{"canonical":"sales.trend","params":{}},"event":{"on":"root.click","payload":{"a":${deepArray}}}}`,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("/binding/action: rejected with 400 BAD_REQUEST before the (missing) capability is even checked", async () => {
    const result = await postJson(
      makeDeps(),
      "/binding/action",
      `{"action":"widget.submit","payload":{"a":${deepArray}}}`,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("whole request body nested this deep (not inside a params/payload field) is rejected by parseBody's own depth check", async () => {
    // Wrapping the deep array directly as the body's "intent" field (not nested under params/payload) exercises
    // requestBodyTooDeep (routes/shared.ts) rather than JsonObjectSchema's field-level guard -- both must hold.
    const result = await postJson(makeDeps(), "/compose", `{"intent":${deepArray}}`);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});
