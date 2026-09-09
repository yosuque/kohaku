/**
 * Pure-logic checks for renderer/host-integration.ts.
 * Pins the reading/writing of widgetState (ChatGPT-specific) and the displayMode toggle decision without a DOM.
 */
import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  canToggleFullscreen,
  nextDisplayMode,
  type OpenAiWidgetApi,
  persistView,
  readPersistedView,
  resolveHostTheme,
} from "../renderer/host-integration.js";

/** Minimal valid Spec that passes parseSpec (wire form). intent.hash must be in `sha256:<hex64>` format. */
const WIRE_SPEC = {
  kohaku: "0.1",
  intent: { canonical: "sales.trend", params: {}, hash: `sha256:${"ab".repeat(32)}` },
  dataVersion: "sales@seed-1",
  components: [
    { id: "root", type: "layout.stack", props: {}, children: ["t"] },
    { id: "t", type: "text.heading", props: { level: 2, text: "Heading" } },
  ],
  events: [],
  provenance: { tier: "L0", composedBy: "test", cache: "miss" },
};

describe("readPersistedView (widgetState restore)", () => {
  it("restores the versioned persisted form (passes parseSpec)", () => {
    const openai: OpenAiWidgetApi = {
      widgetState: { kohaku: 1, spec: WIRE_SPEC, capability: "cap:x" },
    };
    const view = readPersistedView(openai);
    expect(view).not.toBeNull();
    expect(view!.capability).toBe("cap:x");
    expect(view!.spec.intent.canonical).toBe("sales.trend");
  });

  it.each([
    ["API absent", undefined],
    ["no widgetState", {}],
    ["version marker mismatch", { widgetState: { kohaku: 999, spec: WIRE_SPEC, capability: "c" } }],
    ["capability missing", { widgetState: { kohaku: 1, spec: WIRE_SPEC } }],
    ["spec fails parse", { widgetState: { kohaku: 1, spec: { broken: true }, capability: "c" } }],
    ["string (non-object)", { widgetState: "junk" }],
  ])("%s yields null (no restore)", (_label, openai) => {
    expect(readPersistedView(openai as OpenAiWidgetApi | undefined)).toBeNull();
  });
});

describe("persistView (widgetState save)", () => {
  it("saves with a version marker when setWidgetState exists (excludes initialData)", () => {
    const saved: unknown[] = [];
    const openai: OpenAiWidgetApi = { setWidgetState: (s) => saved.push(s) };
    const spec = { ...WIRE_SPEC } as unknown as UISpec;
    persistView(openai, { spec, capability: "cap:y" });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ kohaku: 1, spec, capability: "cap:y" });
  });

  it("no-op when API is absent, swallows setWidgetState throw", () => {
    persistView(undefined, { spec: WIRE_SPEC as unknown as UISpec, capability: "c" });
    const throwing: OpenAiWidgetApi = {
      setWidgetState: () => {
        throw new Error("quota");
      },
    };
    expect(() =>
      persistView(throwing, { spec: WIRE_SPEC as unknown as UISpec, capability: "c" }),
    ).not.toThrow();
  });

  it("save then restore round-trip holds", () => {
    let state: unknown;
    const openai: OpenAiWidgetApi = {
      setWidgetState: (s) => {
        state = s;
      },
      get widgetState() {
        return state;
      },
    };
    persistView(openai, { spec: WIRE_SPEC as unknown as UISpec, capability: "cap:rt" });
    const view = readPersistedView(openai);
    expect(view?.capability).toBe("cap:rt");
    expect(view?.spec.components).toHaveLength(2);
  });
});

describe("displayMode toggle decision", () => {
  it("togglable only when availableDisplayModes includes fullscreen", () => {
    expect(canToggleFullscreen(["inline", "fullscreen"])).toBe(true);
    expect(canToggleFullscreen(["inline", "pip"])).toBe(false);
    expect(canToggleFullscreen([])).toBe(false);
    expect(canToggleFullscreen(undefined)).toBe(false);
  });

  it("transitions between fullscreen and inline (from pip or unknown value goes to fullscreen)", () => {
    expect(nextDisplayMode("fullscreen")).toBe("inline");
    expect(nextDisplayMode("inline")).toBe("fullscreen");
    expect(nextDisplayMode("pip")).toBe("fullscreen");
    expect(nextDisplayMode(undefined)).toBe("fullscreen");
  });
});

describe("resolveHostTheme (hostContext -> { mode, variables } for host-theme adoption)", () => {
  it("extracts mode and style variables from a hostContext-shaped object", () => {
    const resolved = resolveHostTheme({
      theme: "dark",
      styles: { variables: { "--color-background-primary": "#111111" } },
    });
    expect(resolved).toEqual({
      mode: "dark",
      variables: { "--color-background-primary": "#111111" },
    });
  });

  it("defaults to light mode and empty variables when hostContext is undefined", () => {
    expect(resolveHostTheme(undefined)).toEqual({ mode: "light", variables: {} });
  });

  it("defaults to light mode when theme is omitted, but still reads styles.variables", () => {
    expect(resolveHostTheme({ styles: { variables: { "--color-text-primary": "#222" } } })).toEqual({
      mode: "light",
      variables: { "--color-text-primary": "#222" },
    });
  });

  it("any theme value other than the literal 'dark' resolves to light (fail-open on unexpected values)", () => {
    expect(resolveHostTheme({ theme: "light" }).mode).toBe("light");
    expect(resolveHostTheme({ theme: undefined }).mode).toBe("light");
  });

  it("a hostContext with no styles yields an empty variables object (not undefined)", () => {
    expect(resolveHostTheme({ theme: "dark" }).variables).toEqual({});
  });

  it("same function handles both ui/initialize's hostContext and host-context-changed's params shape", () => {
    // Both call sites hand this the same McpUiHostContext shape (getHostContext() vs. the
    // notification's params) — a single extraction covers both without special-casing.
    const initializeHostContext = { theme: "dark" as const, styles: undefined };
    const hostContextChangedParams = { theme: "light" as const, styles: { variables: {} } };
    expect(resolveHostTheme(initializeHostContext).mode).toBe("dark");
    expect(resolveHostTheme(hostContextChangedParams).mode).toBe("light");
  });
});
