import { describe, expect, it } from "vitest";
import { buildDraftPayload, genericInitialDraft, defaultAdminMessages as m } from "../src/index.js";

describe("promotion draft", () => {
  it("genericInitialDraft carries the request as description and leaves wiring empty", () => {
    const d = genericInitialDraft({
      artifactId: "a@1",
      status: "candidate",
      request: "Show a heatmap",
      uses: 1,
      sessions: 1,
      updatedAt: "",
    });
    expect(d).toEqual({
      componentType: "",
      version: "1.0.0",
      intentName: "",
      description: "Show a heatmap",
      paramsJsonSchema: "",
      queryPath: "",
      fixedParams: "",
      paramMap: "",
    });
  });

  it("buildDraftPayload omits empty optional fields and rejects invalid JSON", () => {
    const base = {
      componentType: "x.y",
      version: "1.0.0",
      intentName: "x.y_intent",
      description: "d",
      paramsJsonSchema: "",
      queryPath: "",
      fixedParams: "",
      paramMap: "",
    };
    expect(buildDraftPayload(base, m)).toEqual({
      ok: true,
      payload: { componentType: "x.y", version: "1.0.0", intentName: "x.y_intent", description: "d" },
    });
    const bad = buildDraftPayload({ ...base, paramsJsonSchema: "{" }, m);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.startsWith("paramsJsonSchema has invalid JSON")).toBe(true);
    const wired = buildDraftPayload(
      { ...base, queryPath: "trend", fixedParams: '{"metric":"revenue"}', paramMap: '{"fy":"fy"}' },
      m,
    );
    expect(wired).toEqual({
      ok: true,
      payload: {
        componentType: "x.y",
        version: "1.0.0",
        intentName: "x.y_intent",
        description: "d",
        queryTemplate: { path: "trend", fixedParams: { metric: "revenue" }, paramMap: { fy: "fy" } },
      },
    });
  });
});
