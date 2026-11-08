import { describe, expect, it } from "vitest";
import { normalizeVendorBaseUrl, versionedBaseUrl } from "../src/base-url.js";

describe("normalizeVendorBaseUrl / versionedBaseUrl", () => {
  it("ignores unset, empty and blank values for every provider", () => {
    for (const provider of ["claude", "openai", "gemini", "ollama", "llama"] as const) {
      expect(normalizeVendorBaseUrl(provider, undefined)).toBeUndefined();
      expect(normalizeVendorBaseUrl(provider, "")).toBeUndefined();
      expect(normalizeVendorBaseUrl(provider, "  ")).toBeUndefined();
      expect(versionedBaseUrl(provider, "")).toBeUndefined();
    }
  });

  it("claude: strips slashes and one trailing /v1, then re-adds /v1 for the TypeScript SDK", () => {
    expect(normalizeVendorBaseUrl("claude", "https://gw.example/v1/")).toBe("https://gw.example");
    expect(normalizeVendorBaseUrl("claude", "https://gw.example/anthropic/v1")).toBe(
      "https://gw.example/anthropic",
    );
    // Only a trailing, whole segment counts: /v10 and /xv1 are paths of their own.
    expect(normalizeVendorBaseUrl("claude", "https://gw.example/v10")).toBe("https://gw.example/v10");
    expect(versionedBaseUrl("claude", "https://gw.example")).toBe("https://gw.example/v1");
    expect(versionedBaseUrl("claude", "https://gw.example/v1")).toBe("https://gw.example/v1");
  });

  it("gemini: strips slashes and one trailing /v1beta, then re-adds /v1beta", () => {
    expect(normalizeVendorBaseUrl("gemini", "https://gw.example/v1beta/")).toBe("https://gw.example");
    expect(versionedBaseUrl("gemini", "https://gw.example/google")).toBe("https://gw.example/google/v1beta");
  });

  it("openai / ollama / llama: the OpenAI-compatible value is used as given", () => {
    for (const provider of ["openai", "ollama", "llama"] as const) {
      expect(normalizeVendorBaseUrl(provider, "https://gw.example/v1/")).toBe("https://gw.example/v1/");
      expect(versionedBaseUrl(provider, "https://gw.example/v1")).toBe("https://gw.example/v1");
    }
  });
});
