import {
  createDataInvalidationBus,
  createSpecStateStore,
  type DataInvalidationBus,
  DEFAULT_LOCALE,
  DEFAULT_MESSAGES,
  type RendererMessages,
  type SpecStateStore,
  type SurfaceEvent,
  themeTokensToCssVars,
} from "@kohaku-ui/renderer-core";
import { ROOT_COMPONENT_ID, type ThemeTokens, type UISpec } from "@kohaku-ui/spec-core";
import { noop } from "./dom.js";
import { createCoreRenderRegistry } from "./registry.js";
import { createRuntime, mountTree } from "./tree.js";
import type { PartBuilder, SurfaceContext, Teardown } from "./types.js";

/** Name of the forward event dispatched by <kohaku-surface> (detail is a SurfaceEvent). */
export const KOHAKU_EVENT = "kohaku-event";

/**
 * Individual context properties whose change requires tearing down and rebuilding the mounted tree
 * (they are baked into the RenderRuntime at #render time — binding/theme/locale/messages feed the
 * BoundDataController / theme resolution / message lookup, and sandbox is read at mount time by the
 * sandbox.html part builder). `onEvent` / `onNodeError` / `onActionResult` are deliberately **not** in
 * this set: they are read live from `#context` at call time (see `#dispatchForward` and the wrapper
 * closures built in `#render`), so reassigning one of them mid-lifecycle must not force a full rebuild.
 */
const REBUILD_KEYS = new Set<keyof SurfaceContext>(["binding", "theme", "locale", "messages", "sandbox"]);

/** Every property <kohaku-surface> exposes as a plain instance accessor (used by #upgradeProperty). */
const UPGRADE_PROPS = [
  "spec",
  "context",
  "binding",
  "theme",
  "locale",
  "messages",
  "onEvent",
  "onNodeError",
  "onActionResult",
  "sandbox",
] as const;

/**
 * The single host element <kohaku-surface> (Shadow DOM). It builds the entire UI Spec tree into one shadow root
 * (rather than a Custom Element per part type — a single-element surface). Spec / context are received as properties.
 *
 * Lifecycle:
 * - On every spec swap: store.resetForIntent(intent.hash) → rebuild the tree + reattach the BoundDataController.
 *   The same intent.hash retains state (patch / streaming swaps). Streaming is out of scope for v1.
 * - Forward events are a CustomEvent("kohaku-event", { detail }) (bubbles+composed) + the onEvent property.
 * - Themes are inline-expanded by each part via resolveToken (pixel-match). In addition, CSS variables are laid down on :host (the external override point).
 */
export class KohakuSurface extends HTMLElement {
  #root: HTMLDivElement;
  #spec: UISpec | null = null;
  #context: SurfaceContext = {};
  #registry: Map<string, PartBuilder> = createCoreRenderRegistry();

  // The store is retained by intent.hash; the bus stays the same for the surface's lifetime (equivalent to renderer-react's Provider useRef bus).
  #store: SpecStateStore | null = null;
  #bus: DataInvalidationBus = createDataInvalidationBus();
  #teardown: Teardown = noop;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // Minimal reset only (appearance is carried by each part's inline style = the pixel-match mechanism).
    style.textContent = ":host{display:block}";
    this.#root = document.createElement("div");
    this.#root.className = "kohaku-root";
    shadow.append(style, this.#root);
  }

  connectedCallback(): void {
    // Standard Custom Elements "upgrade property" pattern: a value assigned on this element before the
    // class was registered (customElements.define) — a common pattern when the element is constructed
    // eagerly and defined lazily — lands as a plain own-property that shadows this class's accessor
    // forever, so its setter logic (patchContext / re-render) would never fire again once the element is
    // upgraded. Re-apply each such value through its accessor exactly once, here, at upgrade time
    // (connectedCallback always fires after the class is defined). A no-op for an element created after
    // define() (no own-property was ever set).
    for (const prop of UPGRADE_PROPS) this.#upgradeProperty(prop);
    if (this.#spec != null) this.#render();
  }

  disconnectedCallback(): void {
    this.#teardown();
    this.#teardown = noop;
  }

  #upgradeProperty(prop: (typeof UPGRADE_PROPS)[number]): void {
    const self = this as unknown as Record<string, unknown>;
    if (!Object.hasOwn(this, prop)) return;
    const value = self[prop];
    delete self[prop];
    self[prop] = value;
  }

  /** UI Spec. Setting it triggers resetForIntent → rebuild the tree + reattach the controller. */
  get spec(): UISpec | null {
    return this.#spec;
  }
  set spec(next: UISpec | null) {
    // No rebuild needed for the same reference (context updates are not missed because each setter runs #render separately).
    if (next === this.#spec) return;
    this.#spec = next;
    this.#render();
  }

  /**
   * Batch context assignment (binding / theme / messages / onEvent, etc.). It can also be set via individual
   * properties, but passing it all at once means only one rebuild. Setting it before spec is recommended (minimizes rebuilds due to assignment order).
   */
  get context(): SurfaceContext {
    return this.#context;
  }
  set context(next: SurfaceContext) {
    this.#context = next ?? {};
    if (this.#spec != null) this.#render();
  }

  /** Individual context properties (sugar for partially updating context). */
  set binding(v: SurfaceContext["binding"]) {
    this.#patchContext({ binding: v });
  }
  set theme(v: ThemeTokens | undefined) {
    this.#patchContext({ theme: v });
  }
  set locale(v: string | undefined) {
    this.#patchContext({ locale: v });
  }
  set messages(v: Partial<RendererMessages> | undefined) {
    this.#patchContext({ messages: v });
  }
  set onEvent(v: SurfaceContext["onEvent"]) {
    this.#patchContext({ onEvent: v });
  }
  set onNodeError(v: SurfaceContext["onNodeError"]) {
    this.#patchContext({ onNodeError: v });
  }
  set onActionResult(v: SurfaceContext["onActionResult"]) {
    this.#patchContext({ onActionResult: v });
  }
  set sandbox(v: SurfaceContext["sandbox"]) {
    this.#patchContext({ sandbox: v });
  }

  #patchContext(patch: Partial<SurfaceContext>): void {
    // Skip rebuild if there is no effective change after applying the patch (prevents a full rebuild when the same value is re-assigned to a setter).
    // A shallow reference comparison suffices (binding/theme/messages, etc. are updated by swapping object references).
    let changed = false;
    let needsRebuild = false;
    for (const key of Object.keys(patch) as (keyof SurfaceContext)[]) {
      if (this.#context[key] !== patch[key]) {
        changed = true;
        if (REBUILD_KEYS.has(key)) needsRebuild = true;
      }
    }
    if (!changed) return;
    this.#context = { ...this.#context, ...patch };
    // onEvent/onNodeError/onActionResult changing does not, by itself, require tearing down and rebuilding
    // the mounted tree (see REBUILD_KEYS's doc) — they are read live from #context, not baked into it.
    if (needsRebuild && this.#spec != null) this.#render();
  }

  #render(): void {
    // Tear down the previous tree (controller detach / unsubscribe / sandbox destroy / anchor removal).
    this.#teardown();
    this.#teardown = noop;
    this.#root.replaceChildren();

    const spec = this.#spec;
    if (spec == null) return;

    const theme: ThemeTokens = this.#context.theme ?? {};
    const messages: RendererMessages = { ...DEFAULT_MESSAGES, ...(this.#context.messages ?? {}) };
    const locale = this.#context.locale ?? DEFAULT_LOCALE;

    // Store: retained by intent.hash (same → keep state, different → reinitialize from spec.state). Call before building the tree.
    const initialState = spec.state ?? {};
    if (this.#store == null) {
      this.#store = createSpecStateStore(spec.intent.hash, initialState);
    } else {
      this.#store.resetForIntent(spec.intent.hash, initialState);
    }

    // CSS variables on :host (the theme override point from external CSS; the pixel-match itself uses inline tokens).
    for (const [name, value] of Object.entries(themeTokensToCssVars(theme))) {
      this.style.setProperty(name, value);
    }

    const rt = createRuntime({
      spec,
      store: this.#store,
      bus: this.#bus,
      theme,
      locale,
      messages,
      // onNodeError/onActionResult are wrapped so RenderRuntime always reads the *current* #context value
      // at call time, rather than the value snapshotted at this #render — see REBUILD_KEYS's doc: changing
      // just one of these callbacks does not go through #render again, so RenderRuntime's own onNodeError/
      // onActionResult fields (baked in once here) must forward through a stable indirection instead of
      // holding a stale reference to whatever callback existed when the tree was last built.
      ctx: {
        ...this.#context,
        onNodeError: (args) => this.#context.onNodeError?.(args),
        onActionResult: (args) => this.#context.onActionResult?.(args),
      },
      registry: this.#registry,
      dispatchForward: (event) => this.#dispatchForward(event),
    });

    this.#teardown = mountTree(rt, this.#root, ROOT_COMPONENT_ID);
  }

  #dispatchForward(event: SurfaceEvent): void {
    // composed so it crosses the shadow boundary and reaches the host page. Flows to both paths regardless of whether a sink exists.
    this.dispatchEvent(new CustomEvent(KOHAKU_EVENT, { detail: event, bubbles: true, composed: true }));
    this.#context.onEvent?.(event);
  }
}

/** Registers <kohaku-surface> as a custom element (idempotent). */
export function defineKohakuSurface(tagName = "kohaku-surface"): void {
  if (customElements.get(tagName) == null) {
    customElements.define(tagName, KohakuSurface);
  }
}
