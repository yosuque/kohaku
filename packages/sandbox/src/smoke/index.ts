/**
 * Pre-delivery smoke validation of L2-generated HTML (server side).
 *
 * Even when it passes the composer's static lint (collectL2Issues: hallucinated APIs / missing ready / syntax
 * errors / truncation, etc.), the slow, unfriendly failure where a runtime TypeError never reaches ready() and
 * "nothing renders on the client until the boot timeout (default 5 seconds)" slips through. To detect this
 * before delivery, this module runs the **exact same production code path** as the browser — `domApplierMain`
 * (as a plain function call, against a jsdom document standing in for the trusted iframe document) driving a
 * Worker built from `buildWorkerShimJs() + scripts` (executed via `node:vm` instead of a real Worker, since
 * jsdom has none) — and waits for `ui.ready` to reach the (synthetic) parent side.
 *
 * The guest contract is only the 4 APIs of `window.kohaku` (the counterpart to the surface exposed by
 * `guest/worker-shim.ts`): fetchData(ref) -> Promise<TabularData> / emit(on, payload) / onProps(cb) / ready().
 *
 * Only 2 fatal signals are checked:
 *   - L2_SMOKE_RUNTIME_ERROR: a runtime exception before ready is reached (a synchronous throw while the
 *     Worker boots, an async unhandled rejection inside the generated script, or a shim API the generated
 *     script used that does not exist — all surface as a TypeError the same way they would in production).
 *   - L2_SMOKE_NO_READY: ready() was not called within readyTimeoutMs.
 *
 * From the composer it is wired as an optional hook (ComposePolicy.l2Smoke). The composer does not depend on
 * sandbox (only the type signatures are matched), so the wiring is the app's responsibility.
 *
 * TRUST ASSUMPTION / NOT A SECURITY BOUNDARY: unlike the browser-side runtime (an opaque-origin
 * `<iframe sandbox>` + nonce-only CSP + Worker + applier allowlist + bridge allowlist defense-in-depth, see
 * docs/design.md §8), this module runs the generated `<script>` inside `node:vm` **in the host process
 * itself**, injecting host-realm closures directly into the script's execution context. Nothing here isolates
 * the script from the host process's memory or environment — the `vm` timeout below only guards against a
 * synchronous infinite loop, not against a script that reads/exfiltrates process state or otherwise abuses
 * running in-process. Only wire `createL2Smoke` where the HTML it validates is trusted input (i.e. produced by
 * this codebase's own composer L1/L2 generation pipeline under a fixed system prompt, as in every current
 * deployment) — never on a path where an end user or other untrusted party can get arbitrary HTML in front of
 * it. If a deployment ever needs that, isolate the smoke run itself first (a worker thread or a separate
 * child process), since `createL2Smoke` provides no isolation on its own.
 */
import {
  ALLOWED_ATTR_PREFIXES,
  ALLOWED_ATTRS,
  ALLOWED_PROPERTY_OPS,
  ALLOWED_STYLE_PROPS,
  ALLOWED_TAGS,
  ALWAYS_DENIED_ATTRS,
  type ColumnType,
  type DataShape,
  DEFAULT_MAX_DOM_DEPTH,
  DEFAULT_MAX_DOM_NODES,
  DEFAULT_MUTATIONS_PER_MINUTE,
  type JsonObject,
  type JsonValue,
  type TabularColumn,
  type TabularData,
} from "@kohaku-ui/spec-core";
import { splitArtifact } from "../guest/artifact-parts.js";
import { type DomApplierAllowlist, domApplierMain } from "../guest/dom-applier.js";
import { buildWorkerShimJs } from "../guest/worker-shim.js";

/** Options for createL2Smoke. */
export interface L2SmokeOptions {
  /** Upper bound (ms) to wait for ready() to be reached. Default 1000. Exceeding it yields L2_SMOKE_NO_READY. */
  readyTimeoutMs?: number;
}

/** The invocation context of smoke validation (passed by the composer's l2Smoke hook). */
export interface L2SmokeContext {
  ref?: string;
  shape?: DataShape;
}

const ALLOWLIST: DomApplierAllowlist = {
  tags: [...ALLOWED_TAGS],
  attrs: [...ALLOWED_ATTRS],
  attrPrefixes: [...ALLOWED_ATTR_PREFIXES],
  alwaysDeniedAttrs: [...ALWAYS_DENIED_ATTRS],
  styleProps: [...ALLOWED_STYLE_PROPS],
  propertyOps: [...ALLOWED_PROPERTY_OPS],
};

/**
 * Creates an L2 smoke validator. The return value is a function that can be passed straight to ComposePolicy.l2Smoke
 * (`(html, ctx) => Promise<string[]>`. non-empty = sent back as repair issues / [] = pass).
 *
 * jsdom and node:vm are optional peers. In environments where either is not installed, validation is
 * impossible, so it quietly returns `[]` (fail-open). Unexpected failures of the validator itself
 * (construction failure, etc.) also err on the side of not stopping delivery (the same fail-open style as the
 * token/call budget guard).
 *
 * See the module-level doc above: this runs the `html` argument's script in the host process (node:vm) with
 * no isolation from it, so only call this with trusted-origin HTML (this codebase's own L1/L2 generation
 * output) — never wire it onto a path where untrusted input can reach the `html` argument directly.
 */
export function createL2Smoke(
  opts: L2SmokeOptions = {},
): (html: string, ctx: L2SmokeContext) => Promise<string[]> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 1000;
  return (html, ctx) => runSmoke(html, ctx, readyTimeoutMs);
}

interface OutboundMessage {
  method: string;
  id?: number;
  params?: { kind?: string; detail?: string; [key: string]: unknown };
}

async function runSmoke(html: string, ctx: L2SmokeContext, readyTimeoutMs: number): Promise<string[]> {
  let jsdom: JsdomModule;
  let vm: VmModule;
  try {
    [jsdom, vm] = await Promise.all([loadJsdom(), loadVm()]);
  } catch {
    // An environment without jsdom / node:vm = validation impossible. Quietly pass through with fail-open (see docstring).
    return [];
  }

  const parts = splitArtifact(html);
  let fatal: string | null = null;
  let ready = false;
  const recordFatal = (issue: string): void => {
    if (fatal == null && !ready) fatal = issue;
  };

  let dom: JsdomInstance;
  try {
    dom = new jsdom.JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      pretendToBeVisual: true,
    });
  } catch {
    // A failure of the construction itself is treated as a validator-side problem: fail-open.
    return [];
  }
  const window = dom.window;

  // The Worker side runs via node:vm (jsdom has no Worker). A promise rejected inside the generated script
  // that nothing ever catches becomes a process-level unhandledRejection — jsdom 29's own realm has the same
  // gap for window-level scripts (see the historical note this replaces), and vm contexts have it too, since
  // nothing here dispatches a DOM-style "unhandledrejection" event on the vm's `self`. The promise's realm
  // (its constructor) is checked so an unrelated rejection elsewhere in the host process is never mistaken
  // for a failure of the artifact being validated.
  let workerPromiseCtor: PromiseConstructor | null = null;
  const proc = getProcess();
  const onUnhandledRejection: RejectionListener = (reason, promise) => {
    if (workerPromiseCtor != null && !(promise instanceof workerPromiseCtor)) return;
    recordFatal(runtimeErrorIssue(errorMessage(reason)));
  };
  if (proc != null) proc.on("unhandledRejection", onUnhandledRejection);

  const outbound: OutboundMessage[] = [];
  const fakePort: FakePort = {
    onmessage: null,
    close(): void {
      /* no-op */
    },
    postMessage: (msg: unknown): void => {
      const m = msg as OutboundMessage;
      outbound.push(m);
      if (m.method === "binding.fetch") {
        // Answers exactly like the real bridge (see host-bridge.ts), but deterministically from shape instead
        // of resolving a real DomainPort — no randomness or clock, so same input -> same result.
        queueMicrotask(() => {
          fakePort.onmessage?.({
            data: { method: "rpc.result", id: m.id, result: synthesizeData(ctx.shape) },
          });
        });
      }
    },
  };

  class VmWorker {
    private listeners: Record<string, Array<(e: any) => void>> = {};
    private selfListeners: Record<string, Array<(e: { data: unknown }) => void>> = {};
    private pendingToWorker: unknown[] = [];
    private scriptStarted = false;

    constructor(_url: string) {
      const sandbox: Record<string, unknown> = {
        postMessage: (msg: unknown) => {
          for (const cb of this.listeners["message"] ?? []) cb({ data: msg });
        },
        addEventListener: (type: string, cb: (e: { data: unknown }) => void) => {
          this.selfListeners[type] ??= [];
          this.selfListeners[type].push(cb);
        },
        removeEventListener: (type: string, cb: (e: { data: unknown }) => void) => {
          this.selfListeners[type] = (this.selfListeners[type] ?? []).filter((f) => f !== cb);
        },
        setTimeout,
        clearTimeout,
        queueMicrotask,
        console,
        Date,
      };
      const context = vm.createContext(sandbox);
      (context as Record<string, unknown>)["self"] = context;
      workerPromiseCtor = (context as { Promise: PromiseConstructor }).Promise;
      // Deferred to a microtask (not run synchronously in this constructor): a real Worker never executes its
      // script synchronously either — postMessage/addEventListener calls domApplierMain makes on the freshly
      // constructed `worker` (right after `new Worker(url)` returns, see dom-applier.ts's boot sequence) must
      // land before the script's own top-level code runs and starts sending messages the other way, or the
      // very first ones (e.g. the initial "viewport" message) would already have nowhere to arrive — see
      // `postMessage` below, which queues until this has run.
      queueMicrotask(() => {
        try {
          // Synchronous execution only — a while(true){} in the generated script hits this wall-clock cap the
          // same way the smoke module's predecessor capped inline <script> execution. Anything after the
          // first microtask/timer tick is governed by waitUntil's readyTimeoutMs below, not this timeout.
          vm.runInContext(pendingWorkerSource, context, { timeout: readyTimeoutMs });
        } catch (e) {
          this.scriptStarted = true;
          // Mirrors a real Worker's top-level synchronous throw, which surfaces via its "error" event rather
          // than propagating into whatever called `new Worker(...)` (which by then has already returned).
          // Shaped like a real ErrorEvent (`.message` directly, no `.data` wrapper) — dom-applier.ts's own
          // "error" listener reads `e?.message`, matching the browser Worker contract, not the postMessage one.
          for (const cb of this.listeners["error"] ?? []) cb({ message: errorMessage(e) });
          return;
        }
        this.scriptStarted = true;
        const queued = this.pendingToWorker;
        this.pendingToWorker = [];
        for (const m of queued) {
          for (const cb of this.selfListeners["message"] ?? []) cb({ data: m });
        }
      });
    }

    postMessage(msg: unknown): void {
      if (!this.scriptStarted) {
        this.pendingToWorker.push(msg);
        return;
      }
      for (const cb of this.selfListeners["message"] ?? []) cb({ data: msg });
    }
    addEventListener(type: string, cb: (e: any) => void): void {
      this.listeners[type] ??= [];
      this.listeners[type].push(cb);
    }
    terminate(): void {
      this.selfListeners = {};
    }
  }

  let pendingWorkerSource = "";
  const previous = installGlobals(window, {
    Worker: VmWorker,
    Blob: class {
      parts: unknown[];
      constructor(parts: unknown[]) {
        this.parts = parts;
      }
    },
  });
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  (URL as unknown as { createObjectURL: (b: { parts: unknown[] }) => string }).createObjectURL = (blob) => {
    pendingWorkerSource = blob.parts.join("");
    return "blob:l2-smoke";
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {
    /* no-op */
  };

  try {
    try {
      domApplierMain({
        nonce: "l2-smoke",
        maxDomNodes: DEFAULT_MAX_DOM_NODES,
        maxDomDepth: DEFAULT_MAX_DOM_DEPTH,
        mutationsPerMinute: DEFAULT_MUTATIONS_PER_MINUTE,
        workerShimJs: buildWorkerShimJs({
          rpcTimeoutMs: readyTimeoutMs,
          viewportWidth: 800,
          bodyHtml: parts.body,
        }),
        scripts: parts.scripts.join("\n;\n"),
        allowlist: ALLOWLIST,
      });
    } catch (e) {
      if (isVmTimeoutError(e)) return [];
      throw e;
    }
    // Completes the handshake synchronously (mirrors mount.ts's real MessageChannel handoff) so ui.ready /
    // telemetry.report reach `outbound` instead of sitting in domApplierMain's pre-handshake queue.
    const handshake = new window.MessageEvent("message", { data: { method: "handshake.init" } });
    Object.defineProperty(handshake, "ports", { value: [fakePort], configurable: true });
    window.dispatchEvent(handshake);

    await waitUntil(() => {
      for (const m of outbound) {
        if (m.method === "ui.ready") {
          ready = true;
          return true;
        }
        if (m.method === "telemetry.report" && m.params?.kind === "error") {
          const detail = m.params.detail ?? "";
          if (isVmTimeoutError({ message: detail })) return true; // resolved as fail-open below
          recordFatal(runtimeErrorIssue(detail));
          return true;
        }
      }
      return fatal != null;
    }, readyTimeoutMs);

    if (
      outbound.some(
        (m) => m.method === "telemetry.report" && isVmTimeoutError({ message: m.params?.detail ?? "" }),
      )
    ) {
      return [];
    }
    if (fatal != null) return [fatal];
    if (!ready) return [noReadyIssue(readyTimeoutMs)];
    return [];
  } finally {
    restoreGlobals(previous);
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    if (proc != null) proc.off("unhandledRejection", onUnhandledRejection);
    try {
      window.close();
    } catch {
      /* Swallow a close failure (it does not affect the validation result) */
    }
  }
}

/** Temporarily installs jsdom's window-realm globals (plus the given overrides) onto globalThis, returning what to restore. */
function installGlobals(window: JsdomWindow, overrides: Record<string, unknown>): Record<string, unknown> {
  const names = ["document", "window", "Element", "HTMLElement", "SVGElement", "ResizeObserver"];
  const previous: Record<string, unknown> = {};
  const g = globalThis as Record<string, unknown>;
  for (const name of names) {
    previous[name] = g[name];
    g[name] = (window as unknown as Record<string, unknown>)[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    previous[name] = g[name];
    g[name] = value;
  }
  // jsdom lacks ResizeObserver; domApplierMain's own try/catch around `new ResizeObserver(...)` tolerates its
  // absence (the initial ui.resize it sends beforehand is unaffected), so no stub is installed here.
  return previous;
}

function restoreGlobals(previous: Record<string, unknown>): void {
  const g = globalThis as Record<string, unknown>;
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete g[name];
    else g[name] = value;
  }
}

interface FakePort {
  postMessage(msg: unknown): void;
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

/** Deterministically synthesizes sample TabularData (3 rows) from shape. Empty when shape is unspecified. */
function synthesizeData(shape: DataShape | undefined): TabularData {
  if (shape == null) return { columns: [], rows: [], dataVersion: "smoke" };
  const columns: TabularColumn[] = shape.columns.map((c) => ({ key: c.name, type: c.type }));
  const rows: JsonObject[] = [0, 1, 2].map((i) => {
    const row: JsonObject = {};
    for (const c of shape.columns) {
      row[c.name] = SAMPLE_COLUMN_VALUES[c.type][i];
    }
    return row;
  });
  return { columns, rows, dataVersion: "smoke" };
}

/** Deterministic sample values per column type (for 3 rows). No randomness or clock. */
const SAMPLE_COLUMN_VALUES: Record<ColumnType, readonly [JsonValue, JsonValue, JsonValue]> = {
  number: [1, 2, 3],
  string: ["SampleA", "SampleB", "SampleC"],
  boolean: [true, false, true],
  date: ["2026-01-01", "2026-02-01", "2026-03-01"],
};

function runtimeErrorIssue(message: string): string {
  const detail = message.replace(/\s+/g, " ").trim().slice(0, 300);
  return (
    `L2_SMOKE_RUNTIME_ERROR: A runtime error occurred during smoke validation and rendering did not complete (${detail}). ` +
    "An exception was thrown before window.kohaku.ready() was reached. Review for references to nonexistent variables or properties, or " +
    "calls to APIs that do not exist in the sandbox, and make rendering complete without throwing"
  );
}

function noReadyIssue(timeoutMs: number): string {
  return (
    `L2_SMOKE_NO_READY: window.kohaku.ready() was not called at runtime (smoke validation, within ${timeoutMs}ms). ` +
    "Always call window.kohaku.ready() directly when rendering completes, including when data fetching fails " +
    "(destructuring or calling via an alias is not allowed)"
  );
}

/** Polls with a realtimer until the predicate is true (does not use timer acceleration). */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const pollMs = 10;
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (reason != null && typeof reason === "object" && "message" in reason) {
    const m = (reason as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(reason);
}

function isVmTimeoutError(e: unknown): boolean {
  // An Error originating from the vm context has a different realm than Node's own Error, so instanceof is false.
  // Node vm: "Script execution timed out after Nms" (+ some implementations set code: 'ERR_SCRIPT_EXECUTION_TIMEOUT')
  const msg = errorMessage(e);
  if (/timed out/i.test(msg)) return true;
  if (e != null && typeof e === "object" && "code" in e) {
    return (e as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
  }
  return false;
}

// --- Minimal structural types for jsdom / the Node process (so as not to pull in @types/jsdom / @types/node) ---

interface JsdomModule {
  JSDOM: new (html: string, options: JsdomOptions) => JsdomInstance;
}

interface JsdomInstance {
  window: JsdomWindow;
}

interface JsdomOptions {
  pretendToBeVisual?: boolean;
}

interface JsdomWindow {
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: unknown): void;
  MessageEvent: new (type: string, init: { data: unknown }) => unknown;
  document: unknown;
  [key: string]: unknown;
}

interface VmModule {
  createContext(sandbox: object): object;
  runInContext(code: string, context: object, options?: { timeout?: number }): unknown;
}

type RejectionListener = (reason: unknown, promise: unknown) => void;

interface NodeProcessLike {
  on(event: "unhandledRejection", listener: RejectionListener): void;
  off(event: "unhandledRejection", listener: RejectionListener): void;
}

function getProcess(): NodeProcessLike | null {
  const p = (globalThis as { process?: unknown }).process;
  if (
    p != null &&
    typeof (p as NodeProcessLike).on === "function" &&
    typeof (p as NodeProcessLike).off === "function"
  ) {
    return p as NodeProcessLike;
  }
  return null;
}

async function loadJsdom(): Promise<JsdomModule> {
  // jsdom is an optional peer (we do not pull in its type definitions). We dynamic-import it using a variable specifier to avoid TS's static resolution.
  const moduleName = "jsdom";
  return (await import(moduleName)) as unknown as JsdomModule;
}

async function loadVm(): Promise<VmModule> {
  // node:vm is a Node built-in. In a browser it is undefined, so the dynamic import fails -> fail-open.
  const moduleName = "node:vm";
  return (await import(moduleName)) as unknown as VmModule;
}
