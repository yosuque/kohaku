import { type ComposeView, createKohakuClient, type IntentArg } from "@kohaku-ui/client";
import {
  defineKohakuSurface,
  KOHAKU_EVENT,
  type KohakuSurface,
  type SurfaceEvent,
} from "@kohaku-ui/renderer-wc";
import { JA_MESSAGES } from "./messages-ja.js";
import { buildTheme, type ThemeMode } from "./theme.js";

// Zero-React vanilla page: uses the typed client (@kohaku-ui/client) to call sample-api (:8787) and feeds
// the compose result into <kohaku-surface> (Web Components). The A1 cross-filter (region branching) is
// established without firing a compose, via effective-ref re-resolution of control.select -> state.set -> data.bind.

defineKohakuSurface();

// Reaches the REST profile via vite's proxy (/api -> :8787).
const client = createKohakuClient({ baseUrl: "/api/kohaku" });

// UI language of the Spec messages. English by default; only `?lang=ja` injects JA_MESSAGES into the surface context
// to demonstrate the RendererMessages i18n override (the page chrome is authored in English and does not switch).
const RENDER_JA = new URLSearchParams(location.search).get("lang") === "ja";

// Intent that includes the A1 cross-filter (quarterly_summary with a region returns control.select + data.bind(region)).
const INITIAL_INTENT: IntentArg = {
  canonical: "sales.quarterly_summary",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "product", region: "japan" },
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const surface = document.createElement("kohaku-surface") as KohakuSurface;
app.appendChild(surface);

// Theme mode (light/dark). The initial value comes from an explicit choice in localStorage -> the OS prefers-color-scheme.
// The page chrome (--app-* in index.html) follows via data-theme; the parts (inside the shadow DOM) follow via surface.theme.
const THEME_STORAGE_KEY = "kohaku-sample-wc.theme";
const toggleBtn = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
const toggleLabel = document.querySelector<HTMLSpanElement>("#theme-toggle-label")!;

function initialMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let themeMode: ThemeMode = initialMode();

function applyTheme(): void {
  document.documentElement.dataset.theme = themeMode;
  toggleLabel.textContent = themeMode === "dark" ? "Dark" : "Light";
  toggleBtn.setAttribute("aria-pressed", String(themeMode === "dark"));
  // If the spec is already rendered, swapping surface.theme triggers #render() and rebuilds the parts.
  surface.theme = buildTheme(themeMode);
}

toggleBtn.addEventListener("click", () => {
  themeMode = themeMode === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  applyTheme();
});

// Reflect data-theme and the initial theme before paint (the parts are rendered together with the spec by applyView at boot time).
applyTheme();

// Upstream events (forward) can also be received as CustomEvents (they arrive redundantly alongside the onEvent property).
// Here we only log them. The actual handling is done in onEvent (handleEvent).
surface.addEventListener(KOHAKU_EVENT, (e) => {
  const detail = (e as CustomEvent<SurfaceEvent>).detail;
  console.debug("[kohaku-event]", detail.on, detail.emit, detail.payload);
});

// The current Intent. After a server recompose (e.g. from a row click), it follows the intent of the new spec.
let currentIntent: IntentArg = INITIAL_INTENT;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function applyView(view: ComposeView, intent: IntentArg): void {
  currentIntent = intent;
  // The capability is obtained from the compose response (it passes /binding/resolve for all region variants).
  const binding = client.binding({ capability: view.capability });
  // English by default (leave messages unset = library default English). Only `?lang=ja` injects JA_MESSAGES to
  // demonstrate the RendererMessages i18n override.
  surface.context = {
    binding,
    theme: buildTheme(themeMode),
    ...(RENDER_JA ? { messages: JA_MESSAGES } : {}),
    onEvent: handleEvent,
  };
  surface.spec = view.spec;
  const p = view.spec.provenance;
  setStatus(`Rendered — provenance: ${p.tier} / ${p.composedBy} (cache: ${p.cache})`);
}

async function handleEvent(event: SurfaceEvent): Promise<void> {
  // intent.patch / intent.replace trigger a server recompose (e.g. drilldown from a table row click).
  // action.invoke is executed directly by the Renderer on the write path, and state.set is completed inside the Renderer,
  // so they never reach here (= region switching is re-resolved on the client side without going through onEvent = A1).
  if (event.emit !== "intent.patch" && event.emit !== "intent.replace") return;
  try {
    setStatus(`Sending event ${event.on}…`);
    const view = await client.sendEvent({ intent: currentIntent, on: event.on, payload: event.payload });
    applyView(view, { canonical: view.spec.intent.canonical, params: view.spec.intent.params });
  } catch (err) {
    setStatus(`Event handling failed: ${describeError(err)}`, true);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function boot(): Promise<void> {
  try {
    setStatus("Composing…");
    const view = await client.compose({ intent: INITIAL_INTENT });
    applyView(view, INITIAL_INTENT);
  } catch (err) {
    setStatus(
      `Compose failed (${describeError(err)}). Start sample-api first: pnpm --filter @kohaku-ui-sample/api dev`,
      true,
    );
  }
}

void boot();
