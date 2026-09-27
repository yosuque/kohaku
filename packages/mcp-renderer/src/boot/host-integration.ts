/**
 * Helpers for integrating with host-specific features. Pure logic split out from main.tsx (subject to unit tests).
 *
 * - widgetState (ChatGPT-specific): the MCP Apps extension has **no** standard persistence mechanism
 *   for widget state (confirmed). Only ChatGPT provides `window.openai.setWidgetState / widgetState`,
 *   so it is feature-detected and used for immediate restore on remount (remount restore). On unsupported hosts, a complete no-op.
 * - displayMode (MCP Apps standard): `ui/request-display-mode` (inline / fullscreen / pip).
 *   Availability is determined by the host context's availableDisplayModes.
 */
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";

/** Minimal structural type of ChatGPT's own widget persistence API (window.openai). */
export interface OpenAiWidgetApi {
  widgetState?: unknown;
  setWidgetState?: (state: unknown) => unknown;
}

export interface PersistedView {
  spec: UISpec;
  capability: string;
}

/** Version marker for the saved shape. Lets us silently discard the old shape when we change the shape in the future. */
const WIDGET_STATE_VERSION = 1;

/**
 * Restore the previous view from widgetState. A different shape, parseSpec failure, or missing API yields null (no restore).
 * initialData is not saved (size and freshness — data is re-resolved fresh via the bridge).
 */
export function readPersistedView(openai: OpenAiWidgetApi | undefined): PersistedView | null {
  const state = openai?.widgetState;
  if (state == null || typeof state !== "object") return null;
  const s = state as { kohaku?: unknown; spec?: unknown; capability?: unknown };
  if (s.kohaku !== WIDGET_STATE_VERSION) return null;
  if (s.spec == null || typeof s.capability !== "string" || s.capability === "") return null;
  try {
    return { spec: parseSpec(s.spec), capability: s.capability };
  } catch {
    return null;
  }
}

/**
 * Save the current view to widgetState (only actually acts on ChatGPT. Failures are swallowed — persistence is
 * a UX improvement, not an essential feature, and a save failure must not break rendering).
 */
export function persistView(
  openai: OpenAiWidgetApi | undefined,
  view: { spec: UISpec; capability: string },
): void {
  if (typeof openai?.setWidgetState !== "function") return;
  try {
    openai.setWidgetState({
      kohaku: WIDGET_STATE_VERSION,
      spec: view.spec,
      capability: view.capability,
    });
  } catch {
    // A save failure is harmless (next time it is displayed via the tool-result / self-recovery paths)
  }
}

/**
 * Key for the initial data co-embedded in the _meta of tool-result / kohaku_event.
 * Keep it in sync with host-mcp-apps's INITIAL_DATA_META_KEY (packages/host-mcp-apps/src/meta.ts).
 * Importing host-mcp-apps would reverse the dependency direction and bloat the single-file bundle,
 * so here it is held as a literal string, and the match is guaranteed by a test (packages/host-mcp-apps/test/mcp.test.ts).
 */
export const INITIAL_DATA_META_KEY = "kohaku/initialData";

/**
 * Key for the compose-issued capability token co-embedded in the _meta of tool-result / kohaku_event.
 * Keep it in sync with host-mcp-apps's CAPABILITY_META_KEY (packages/host-mcp-apps/src/meta.ts). The token
 * moved out of model-visible `structuredContent` into `_meta` (which does not enter the model's context) so a
 * host that ignores app-only tool visibility, or a prompt-injected instruction, cannot have the model itself
 * read a bearer write token. Held here as a literal string for the same reason as INITIAL_DATA_META_KEY
 * (importing host-mcp-apps would reverse the dependency direction and bloat the single-file bundle); the
 * match is guaranteed by a test (packages/host-mcp-apps/test/mcp.test.ts).
 */
export const CAPABILITY_META_KEY = "kohaku/capability";

/** Extract the _meta-embedded initial data from the response of tool-result / kohaku_event into a Map. */
export function readInitialData(result: {
  _meta?: Record<string, unknown>;
}): Map<string, TabularData> | undefined {
  const embedded = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData> | undefined;
  if (embedded == null || typeof embedded !== "object") return undefined;
  return new Map(Object.entries(embedded));
}

/** The view extracted from a tool result ({spec, capability} + the consume-once initial-data map). */
export interface ExtractedSpecView {
  spec: UISpec;
  capability: string;
  initialData?: Map<string, TabularData>;
}

/** extractSpecView's result: ok, or the reason it could not be applied (the caller keeps its own logging / error policy). */
export type SpecViewExtraction =
  | { ok: true; view: ExtractedSpecView }
  | { ok: false; reason: "missing" | "parse-error"; detail: string };

/**
 * Extracts {spec, capability, initialData} from a callServerTool / tool-result payload.
 * The single home of the structure check + parseSpec + _meta initial-data read, shared by the
 * tool-result, self-recovery, and kohaku_event paths in main.tsx.
 */
export function extractSpecView(result: unknown): SpecViewExtraction {
  const r = (result ?? {}) as {
    structuredContent?: { spec?: unknown };
    _meta?: Record<string, unknown>;
  };
  const spec = r.structuredContent?.spec;
  const capability = r._meta?.[CAPABILITY_META_KEY];
  if (spec == null || typeof capability !== "string" || capability === "") {
    return {
      ok: false,
      reason: "missing",
      detail:
        "structuredContent has no spec / _meta has no capability" +
        ` (spec=${spec != null ? "yes" : "no"}, capability=${
          typeof capability === "string" && capability !== "" ? "yes" : "no"
        })`,
    };
  }
  try {
    const parsed = parseSpec(spec);
    const initialData = readInitialData(r);
    return {
      ok: true,
      view: {
        spec: parsed,
        capability,
        ...(initialData != null ? { initialData } : {}),
      },
    };
  } catch (e) {
    return { ok: false, reason: "parse-error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Whether self-recovery may re-call the tool that opened this widget (the cancelled / viewApplied guards
 * stay with the caller — this decides only the tool-name part). Returns null when recovery is possible,
 * otherwise the reason to log and fall to the diagnostic display.
 */
export function recoveryBlockReason(toolName: string | undefined): string | null {
  if (toolName == null) return "no toolInfo";
  // A snapshot-generation tool returns HTML, not a Spec — re-calling it cannot restore the view.
  if (toolName.endsWith("_render_snapshot")) return "a snapshot-generation tool does not return a Spec";
  return null;
}

/**
 * Minimal structural type of the host-context fields this renderer consumes for host-theme
 * adoption. Mirrors `@modelcontextprotocol/ext-apps`'s `McpUiHostContext` (`theme` +
 * `styles.variables`) — both `app.getHostContext()` (used at `ui/initialize`) and
 * `ui/notifications/host-context-changed`'s params satisfy this shape, so the same pure
 * function handles both call sites. Kept as a local structural type (not imported from
 * ext-apps) so this stays a plain-object pure function, testable without constructing an
 * SDK `App`/notification object.
 */
export interface ThemeHostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined> };
}

/** The theming inputs `main.tsx` needs to build `ThemeTokens` for `RendererProvider`. */
export interface ResolvedHostTheme {
  /** Color-scheme mode. Defaults to "light" when the host omits `theme` (matches ext-apps' own light-default convention, see `getDocumentTheme`). */
  mode: "light" | "dark";
  /** `hostContext.styles.variables`, or `{}` when the host sent no style variables. Handed to `themeFromHostStyles` as-is. */
  variables: Record<string, string | undefined>;
}

/**
 * Extracts the host-theme inputs (color-scheme mode + standard style variables) from a
 * `ui/initialize` hostContext or a `ui/notifications/host-context-changed` params object.
 * Pure / DOM-free (no `document` access, unlike ext-apps' own `applyDocumentTheme` /
 * `applyHostStyleVariables`) — the caller picks `defaultLightTheme` / `defaultDarkTheme` by
 * `mode` and overlays it with `themeFromHostStyles(variables, base)` (`@kohaku-ui/renderer-core`)
 * to build the `ThemeTokens` passed to `RendererProvider`.
 *
 * A missing/undefined `hostContext` (unsupported host, or not yet received) yields the
 * light-mode default with no variables — never throws.
 */
export function resolveHostTheme(hostContext: ThemeHostContext | undefined): ResolvedHostTheme {
  return {
    mode: hostContext?.theme === "dark" ? "dark" : "light",
    variables: hostContext?.styles?.variables ?? {},
  };
}

/** Whether the host provides fullscreen toggling (display decision for the displayMode toggle). */
export function canToggleFullscreen(availableDisplayModes: readonly string[] | undefined): boolean {
  return availableDisplayModes?.includes("fullscreen") === true;
}

/** The toggle's next target (fullscreen ⇄ inline. pip is host-driven only and is not a toggle target). */
export function nextDisplayMode(current: string | undefined): "inline" | "fullscreen" {
  return current === "fullscreen" ? "inline" : "fullscreen";
}
