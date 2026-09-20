/**
 * The trusted iframe document's runtime. `domApplierMain` replaces the old in-document `<script>` (see the
 * former runtime.ts) as the thing embedded into the srcdoc's `<script nonce>`. It:
 * 1. performs the exact same parent-facing handshake / bridge protocol as before (protocol.ts and
 *    host-bridge.ts are unchanged — this is why the MessagePort is held here, in the document, and never
 *    transferred into the Worker: only the document may talk to the parent);
 * 2. boots a blob Worker running `config.workerShimJs + config.scripts` (the generated L2 script executes
 *    there, with no `document` of its own — SBX-EXEC-001);
 * 3. relays the Worker's short-array DOM ops into the real DOM, rejecting anything outside the allowlist
 *    (`config.allowlist`, sourced from packages/spec-core/src/schema/sandbox-dom.ts by srcdoc.ts — this file
 *    cannot import spec-core directly, see the guest convention below) — this is the only place real DOM
 *    mutation happens, and the only enforcement point; every op arriving from the Worker is treated as
 *    untrusted regardless of what the shim believes it already validated. `config.maxDomNodes` bounds the
 *    number of nodes **currently connected** to the document (`liveCount`, tracked per subtree via the real
 *    DOM's `Node.isConnected` rather than the lifetime size of `idToNode`), so removing nodes frees budget for
 *    new ones; a separate, larger lifetime cap on `idToNode` itself (`LIFETIME_RECORD_FACTOR × maxDomNodes`)
 *    bounds memory, since a tracked record can never be deleted while generated JS may still hold a reference
 *    to its id and re-append it later (see worker-shim.ts's `emitted` latch);
 * 4. forwards real DOM events on the applied elements back into the Worker so widget event handlers still run;
 * 5. tears the Worker down with `worker.terminate()` on destroy (a forced stop that was impossible for the old
 *    same-document `while(true){}` case).
 *
 * Guest convention: like worker-shim.ts, this file has no imports and no module-scope closures —
 * `domApplierMain.toString()` is embedded verbatim into the srcdoc's inline script. `config.allowlist` exists
 * because of this: the allowlist DATA lives in spec-core (a real import for srcdoc.ts, which builds `config`),
 * but the small allow/deny predicate logic below is a local, literal reimplementation over that data (kept
 * intentionally tiny — Set membership and prefix checks — so duplicating it here carries little drift risk).
 *
 * `typeof Worker !== "function"` is guarded so that calling this in an environment with no Worker global
 * (tests included) fails soft — one `telemetry.report kind:"error"` — rather than an uncaught ReferenceError.
 * test/guest/dom-applier.test.ts drives this file under jsdom by installing a fake `Worker`/`Blob`/`URL`
 * (jsdom itself has none) rather than by making domApplierMain jsdom-aware.
 *
 * Typing note: every browser global this file touches (window/document/Element/HTMLElement/SVGElement/Node/
 * Worker/Blob/ResizeObserver/…) is accessed through `g` (== `globalThis`, typed `any`) rather than as a bare
 * DOM-lib-typed identifier. This file's `domApplierMain` export is imported (for the Worker-free code-path
 * rehearsal — see smoke/index.ts's module docstring) by packages/sandbox/src/smoke/index.ts, which is in turn
 * imported by DOM-free server-side consumers (e.g. apps/sample-api's ComposePolicy wiring) whose tsconfig has
 * no "DOM" lib — requiring one there purely to satisfy this file's own type-checking would leak ambient DOM
 * globals across an otherwise deliberately DOM-free server package, a much wider blast radius than this file's
 * actual (very small, `any`-typed-at-the-boundary) DOM usage warrants.
 */

/** The allowlist data domApplierMain enforces, gathered from spec-core by non-guest code (srcdoc.ts). */
export interface DomApplierAllowlist {
  tags: string[];
  attrs: string[];
  attrPrefixes: string[];
  alwaysDeniedAttrs: string[];
  styleProps: string[];
  propertyOps: string[];
}

export interface DomApplierConfig {
  nonce: string;
  maxDomNodes: number;
  maxDomDepth: number;
  mutationsPerMinute: number;
  /**
   * The full JS source of workerShimMain, ready to concatenate with the generated scripts (see
   * buildWorkerShimJs). Built by srcdoc.ts before the iframe exists, so its baked-in `viewportWidth` is only
   * a placeholder default — domApplierMain corrects it with a `{t:"viewport"}` message right after boot,
   * once the real iframe layout is available.
   */
  workerShimJs: string;
  /** The generated L2 `<script>` bodies, concatenated in document order. */
  scripts: string;
  allowlist: DomApplierAllowlist;
}

/**
 * The guest closure itself. Do not add imports or reference anything outside this function's own body — see
 * the module docstring for why.
 */
export function domApplierMain(config: DomApplierConfig): void {
  "use strict";
  // See the module docstring's "Typing note": every ambient browser global is reached through `g` so this
  // file needs no "DOM" lib, in either this package's own tsconfig or (more importantly) a DOM-free consumer's.
  const g: any = globalThis as any;
  const PROTOCOL = "kohaku-sandbox/0.1"; // mirrors protocol.ts's PROTOCOL (guest closures cannot import it)
  const TELEMETRY_DETAIL_MAX_CHARS = 300; // mirrors guest/constants.ts

  function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) : s;
  }

  // -------------------------------------------------------------------------------------------------------
  // parent-facing bridge (unchanged wire protocol — see protocol.ts / host-bridge.ts)
  // -------------------------------------------------------------------------------------------------------
  interface PortLike {
    postMessage(m: unknown): void;
    close(): void;
    onmessage: ((e: any) => void) | null;
  }
  let port: PortLike | null = null;
  let outboundQueue: unknown[] = [];

  function sendToParent(message: unknown): void {
    if (port != null) port.postMessage(message);
    else outboundQueue.push(message);
  }

  function onHandshake(event: any): void {
    const data: any = event.data;
    if (port != null || data == null || data.method !== "handshake.init") return;
    if (event.ports == null || event.ports[0] == null) return;
    g.window.removeEventListener("message", onHandshake);
    port = event.ports[0] as unknown as PortLike;
    port.onmessage = (e: any) => onParentMessage(e.data);
    const queued = outboundQueue;
    outboundQueue = [];
    for (const m of queued) port!.postMessage(m);
  }
  g.window.addEventListener("message", onHandshake);
  g.window.parent.postMessage({ kohaku: PROTOCOL, method: "handshake.ready", nonce: config.nonce }, "*");

  // -------------------------------------------------------------------------------------------------------
  // real-DOM bookkeeping
  // -------------------------------------------------------------------------------------------------------
  /**
   * A tracked node's lifetime record. Once created, a record is never deleted (see the module docstring):
   * generated JS may hold the id past an `"r"` removal and re-append it later with a bare `"a"` (no `"c"`).
   * `parentId` only reflects the applier's own bookkeeping of the *intended* parent — whether the node is
   * actually connected to the document right now is answered by the real DOM (`el.isConnected`), not by this
   * record, which is why the live-node accounting below reads `isConnected` instead of `parentId != null`.
   */
  interface Tracked {
    el: any;
    parentId: string | null;
    listenerTypes: Set<string>;
  }
  const idToNode = new Map<string, Tracked>();
  const domToId = new WeakMap<object, string>();
  idToNode.set("html", { el: g.document.documentElement, parentId: null, listenerTypes: new Set() });
  idToNode.set("head", { el: g.document.head, parentId: "html", listenerTypes: new Set() });
  idToNode.set("body", { el: g.document.body, parentId: "html", listenerTypes: new Set() });
  domToId.set(g.document.documentElement, "html");
  domToId.set(g.document.head, "head");
  domToId.set(g.document.body, "body");

  // -------------------------------------------------------------------------------------------------------
  // live-node accounting (against config.maxDomNodes) — see the module docstring for the reasoning.
  // -------------------------------------------------------------------------------------------------------
  /** Nodes currently connected to the document. The 3 bootstrap anchors above are connected from the start. */
  let liveCount = 3;
  /**
   * Lifetime cap on `idToNode.size`, independent of `liveCount`: records can never be dropped (see Tracked's
   * doc comment above), so without this a widget that only ever creates and never reuses ids would grow
   * `idToNode` unboundedly even while staying under `maxDomNodes` live nodes at any instant.
   */
  const LIFETIME_RECORD_FACTOR = 10;
  const lifetimeRecordCap = config.maxDomNodes * LIFETIME_RECORD_FACTOR;

  /** Counts `el` and its tracked (`domToId`-registered) descendants — the unit `liveCount` adjusts by. */
  function countTracked(el: any): number {
    let count = domToId.has(el) ? 1 : 0;
    const children = el.childNodes;
    for (let i = 0; i < children.length; i += 1) count += countTracked(children[i]);
    return count;
  }

  // -------------------------------------------------------------------------------------------------------
  // allowlist enforcement (local reimplementation over config.allowlist data — see module docstring)
  // -------------------------------------------------------------------------------------------------------
  const allowedTags = new Set(config.allowlist.tags);
  const allowedAttrs = new Set(config.allowlist.attrs);
  const alwaysDeniedAttrs = new Set(config.allowlist.alwaysDeniedAttrs);
  const allowedStyleProps = new Set(config.allowlist.styleProps);
  const allowedPropertyOps = new Set(config.allowlist.propertyOps);

  // "#text" acceptance here is intentional and NOT a gap relative to spec-core's own isTagAllowed (which
  // deliberately excludes it): text nodes are created by the applier itself (see the "c" op's
  // `tag === "#text"` branch below), never named by generated markup arriving from the Worker, so there is
  // nothing for spec-core's predicate to allow. See packages/spec-core/test/fixtures/sandbox-allowlist-
  // vectors.ts (H10) for the shared vector table that pins this as the one documented divergence between
  // the two allow-lists.
  function isTagAllowed(tag: string): boolean {
    return tag === "#text" || allowedTags.has(tag.toLowerCase());
  }
  function isAttrAllowed(name: string): boolean {
    const lower = name.toLowerCase();
    if (alwaysDeniedAttrs.has(lower) || lower.startsWith("on")) return false;
    if (config.allowlist.attrPrefixes.some((p) => lower.startsWith(p))) return true;
    return allowedAttrs.has(lower);
  }
  function isAttrValueSafe(value: string): boolean {
    return !/javascript\s*:/i.test(value);
  }
  function toKebabCase(prop: string): string {
    return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  }
  function isStylePropAllowed(prop: string): boolean {
    return allowedStyleProps.has(toKebabCase(prop).toLowerCase());
  }
  function isStyleValueSafe(value: string): boolean {
    const lower = value.toLowerCase();
    if (lower.includes("expression(") || lower.includes("@import")) return false;
    for (const m of lower.matchAll(/url\(\s*['"]?([^'")]*)['"]?\s*\)/g)) {
      if (!m[1]!.startsWith("#")) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------------------
  // rate limiting (a tiny local fixed-window counter — cannot import policy.ts's FixedWindowLimiter)
  // -------------------------------------------------------------------------------------------------------
  function makeLimiter(limit: number, windowMs = 60_000) {
    let windowStart = 0;
    let count = 0;
    return () => {
      const now = Date.now();
      if (now - windowStart >= windowMs) {
        windowStart = now;
        count = 0;
      }
      if (count >= limit) return false;
      count += 1;
      return true;
    };
  }
  const mutationLimiter = makeLimiter(config.mutationsPerMinute);
  const deniedNotifyLimiter = makeLimiter(1);

  function notifyDenied(detail: string): void {
    if (!deniedNotifyLimiter()) return;
    sendToParent({
      method: "telemetry.report",
      params: { kind: "denied", detail: truncate(detail, TELEMETRY_DETAIL_MAX_CHARS) },
    });
  }
  function reportError(detail: string): void {
    sendToParent({
      method: "telemetry.report",
      params: { kind: "error", detail: truncate(detail, TELEMETRY_DETAIL_MAX_CHARS) },
    });
  }

  function depthOf(id: string | null): number {
    let depth = 0;
    let current = id;
    while (current != null) {
      const rec = idToNode.get(current);
      if (rec == null) break;
      depth += 1;
      current = rec.parentId;
    }
    return depth;
  }

  // -------------------------------------------------------------------------------------------------------
  // op application
  // -------------------------------------------------------------------------------------------------------
  let readyFlagged = false;

  function applyOp(op: unknown[]): void {
    const kind = op[0];
    if (kind === "R") {
      readyFlagged = true;
      return;
    }
    if (!mutationLimiter()) {
      notifyDenied("mutation rate exceeded");
      return;
    }
    switch (kind) {
      case "c": {
        const [, id, tag, ns] = op as [string, string, string, string?];
        if (idToNode.size >= lifetimeRecordCap) {
          notifyDenied(`max DOM node records exceeded (${lifetimeRecordCap})`);
          return;
        }
        if (liveCount >= config.maxDomNodes) {
          notifyDenied(`max DOM nodes exceeded (${config.maxDomNodes})`);
          return;
        }
        if (!isTagAllowed(tag)) {
          notifyDenied(`tag not allowed: ${tag}`);
          return;
        }
        const el: any =
          tag === "#text"
            ? g.document.createTextNode("")
            : ns != null
              ? g.document.createElementNS(ns, tag)
              : g.document.createElement(tag);
        idToNode.set(id, { el, parentId: null, listenerTypes: new Set() });
        domToId.set(el, id);
        return;
      }
      case "t": {
        const [, id, text] = op as [string, string, string];
        const rec = idToNode.get(id);
        if (rec == null) return;
        rec.el.data = text;
        return;
      }
      case "x": {
        const [, id, text] = op as [string, string, string];
        const rec = idToNode.get(id);
        if (rec == null || !(rec.el instanceof g.Element)) return;
        // textContent = ... detaches every descendant with no corresponding "r" op (see the module docstring's
        // verified premises), so the tracked descendants must be released from liveCount here, before the
        // assignment discards them from the live tree (countTracked walks the real DOM, so it must run first).
        if (rec.el.isConnected === true) liveCount -= countTracked(rec.el) - 1;
        rec.el.textContent = text;
        return;
      }
      case "a": {
        const [, parentId, childId, beforeId] = op as [string, string, string, string | null];
        const parentRec = idToNode.get(parentId);
        const childRec = idToNode.get(childId);
        if (parentRec == null || childRec == null || !(parentRec.el instanceof g.Element)) return;
        if (depthOf(parentId) + 1 > config.maxDomDepth) {
          notifyDenied(`max DOM depth exceeded (${config.maxDomDepth})`);
          return;
        }
        const wasConnected = childRec.el.isConnected === true;
        const willConnect = parentRec.el.isConnected === true;
        const subtree = countTracked(childRec.el);
        if (willConnect && !wasConnected && liveCount + subtree > config.maxDomNodes) {
          notifyDenied(`max DOM nodes exceeded (${config.maxDomNodes})`);
          return;
        }
        const beforeRec = beforeId != null ? idToNode.get(beforeId) : null;
        parentRec.el.insertBefore(childRec.el, beforeRec?.el ?? null);
        childRec.parentId = parentId;
        // insertBefore into a connected parent brings a previously-detached subtree live; moving a connected
        // subtree out to a detached parent releases it. A move within the live tree (both true) or between
        // two detached parents (both false) leaves liveCount unchanged — insertBefore only relocates it.
        if (willConnect && !wasConnected) liveCount += subtree;
        else if (!willConnect && wasConnected) liveCount -= subtree;
        return;
      }
      case "r": {
        const [, parentId, childId] = op as [string, string, string];
        const parentRec = idToNode.get(parentId);
        const childRec = idToNode.get(childId);
        if (parentRec == null || childRec == null || !(parentRec.el instanceof g.Element)) return;
        // Computed before removeChild (isConnected flips to false only after removal); guards against a
        // double decrement if the child was already detached (e.g. a stale "r" for a node "x" already freed).
        if (childRec.el.isConnected === true) liveCount -= countTracked(childRec.el);
        try {
          parentRec.el.removeChild(childRec.el);
        } catch (_e) {
          /* already detached — nothing to do */
        }
        // The record itself is never deleted — see Tracked's doc comment: a removed id can be re-appended
        // with a bare "a" and no "c" (worker-shim.ts's `emitted` latch), so idToNode must still resolve it.
        childRec.parentId = null;
        return;
      }
      case "s": {
        const [, id, name, value, ns] = op as [string, string, string, string | null, string?];
        const rec = idToNode.get(id);
        if (rec == null || !(rec.el instanceof g.Element)) return;
        if (!isAttrAllowed(name)) {
          notifyDenied(`attribute not allowed: ${name}`);
          return;
        }
        if (value == null) {
          rec.el.removeAttribute(name);
          return;
        }
        if (!isAttrValueSafe(value)) {
          notifyDenied(`unsafe attribute value for ${name}`);
          return;
        }
        if (ns != null) rec.el.setAttributeNS(ns, name, value);
        else rec.el.setAttribute(name, value);
        return;
      }
      case "y": {
        const [, id, prop, value] = op as [string, string, string, unknown];
        const rec = idToNode.get(id);
        if (rec == null) return;
        if (!allowedPropertyOps.has(prop)) {
          notifyDenied(`property not allowed: ${prop}`);
          return;
        }
        (rec.el as Record<string, unknown>)[prop] = value;
        return;
      }
      case "p": {
        const [, id, prop, value] = op as [string, string, string, string];
        const rec = idToNode.get(id);
        if (rec == null || (!(rec.el instanceof g.HTMLElement) && !(rec.el instanceof g.SVGElement))) return;
        if (!isStylePropAllowed(prop)) {
          notifyDenied(`style property not allowed: ${prop}`);
          return;
        }
        if (!isStyleValueSafe(value)) {
          notifyDenied(`unsafe style value for ${prop}`);
          return;
        }
        if (value === "") rec.el.style.removeProperty(prop);
        else rec.el.style.setProperty(prop, value);
        return;
      }
      case "l": {
        const [, id, type] = op as [string, string, string];
        idToNode.get(id)?.listenerTypes.add(type);
        return;
      }
      case "u": {
        const [, id, type] = op as [string, string, string];
        idToNode.get(id)?.listenerTypes.delete(type);
        return;
      }
      case "f": {
        const [, id] = op as [string, string];
        const rec = idToNode.get(id);
        if (rec != null && rec.el instanceof g.HTMLElement) rec.el.focus();
        return;
      }
      default:
        return;
    }
  }

  let lastSeq = 0;
  let uiReadyDelivered = false;

  function handleOpsBatch(seq: number, ops: unknown[][]): void {
    if (seq <= lastSeq) {
      notifyDenied("stale or replayed op batch");
      return;
    }
    lastSeq = seq;
    for (const op of ops) applyOp(op);
    if (readyFlagged && !uiReadyDelivered) {
      uiReadyDelivered = true;
      sendToParent({ method: "ui.ready" });
      sendResize();
      try {
        const ro = new g.ResizeObserver(() => sendResize());
        ro.observe(g.document.documentElement);
      } catch (_e) {
        /* ResizeObserver unavailable — the initial size notification above still went out */
      }
    }
  }

  let lastHeight = -1;
  function sendResize(): void {
    const h = g.document.documentElement.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      sendToParent({ method: "ui.resize", params: { height: h } });
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // event forwarding (real DOM -> Worker). submit and any <a> click are always prevented (defense in depth —
  // neither tag is ever createable via the allowlist, but the guard is kept in case that ever changes).
  // -------------------------------------------------------------------------------------------------------
  const BUBBLING_TYPES = [
    "click",
    "dblclick",
    "input",
    "change",
    "keydown",
    "keyup",
    "pointerover",
    "pointerout",
    "pointerdown",
    "pointerup",
    "contextmenu",
    "submit",
  ];
  const THROTTLED_TYPES = ["pointermove", "wheel", "scroll"];
  const lastThrottledAt: Record<string, number> = {};

  function findTrackedId(node: any): string | null {
    let current: any = node;
    while (current != null) {
      const id = domToId.get(current);
      if (id != null) return id;
      current = current.parentNode;
    }
    return null;
  }

  function anyAncestorListens(id: string, type: string): boolean {
    let current: string | null = id;
    while (current != null) {
      const rec = idToNode.get(current);
      if (rec == null) return false;
      if (rec.listenerTypes.has(type)) return true;
      current = rec.parentId;
    }
    return false;
  }

  function extractFields(event: any): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const key of [
      "key",
      "code",
      "ctrlKey",
      "altKey",
      "shiftKey",
      "metaKey",
      "clientX",
      "clientY",
      "offsetX",
      "offsetY",
      "button",
    ]) {
      if (event[key] !== undefined) fields[key] = event[key];
    }
    const target = event.target;
    if (target != null && "value" in target) fields["value"] = target.value;
    if (target != null && "checked" in target) fields["checked"] = target.checked;
    return fields;
  }

  function forwardToWorker(type: string, targetId: string, fields: Record<string, unknown>): void {
    worker?.postMessage({ t: "dom-event", targetId, type, ...fields });
  }

  function onDelegatedEvent(event: any): void {
    const target = event.target;
    if (event.type === "submit") event.preventDefault();
    if (event.type === "click" && target?.closest?.("a") != null) event.preventDefault();
    const id = findTrackedId(event.target);
    if (id == null) return;
    if (!anyAncestorListens(id, event.type)) return;
    forwardToWorker(event.type, id, extractFields(event));
  }

  for (const type of BUBBLING_TYPES) {
    g.document.addEventListener(type, onDelegatedEvent, true);
  }
  for (const type of THROTTLED_TYPES) {
    g.document.addEventListener(
      type,
      (event: any) => {
        const now = Date.now();
        const last = lastThrottledAt[type] ?? 0;
        if (now - last < 1000 / 30) return;
        lastThrottledAt[type] = now;
        onDelegatedEvent(event);
      },
      true,
    );
  }

  // -------------------------------------------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------------------------------------------
  interface WorkerLike {
    postMessage(m: unknown): void;
    terminate(): void;
    addEventListener(t: string, cb: (e: any) => void): void;
  }
  let worker: WorkerLike | null = null;

  function onWorkerMessage(event: { data: any }): void {
    const msg = event.data;
    if (msg == null || typeof msg !== "object") return;
    switch (msg.t) {
      case "ops":
        handleOpsBatch(msg.seq, msg.ops);
        return;
      case "rpc":
        sendToParent({ method: "binding.fetch", id: msg.id, params: { ref: msg.ref } });
        return;
      case "event":
        sendToParent({ method: "event.emit", params: { on: msg.on, payload: msg.payload } });
        return;
      case "telemetry":
        sendToParent({ method: "telemetry.report", params: { kind: msg.kind, detail: msg.detail } });
        return;
      default:
        return;
    }
  }

  function onParentMessage(msg: any): void {
    if (msg == null) return;
    switch (msg.method) {
      case "rpc.result":
        worker?.postMessage({ t: "rpc-result", id: msg.id, result: msg.result, error: msg.error });
        return;
      case "props.update":
        worker?.postMessage({ t: "props", props: msg.params?.props });
        return;
      case "data.invalidate":
        worker?.postMessage({ t: "invalidate", ref: msg.params?.ref });
        return;
      case "destroy":
        worker?.postMessage({ t: "destroy" });
        worker?.terminate();
        port?.close();
        return;
      default:
        return;
    }
  }

  if (typeof g.Worker !== "function") {
    reportError("Worker is not supported in this environment");
    return;
  }
  try {
    const blob = new g.Blob([config.workerShimJs, "\n;", config.scripts], { type: "text/javascript" });
    const url = g.URL.createObjectURL(blob);
    worker = new g.Worker(url) as WorkerLike;
    g.URL.revokeObjectURL(url);
    worker!.addEventListener("message", onWorkerMessage);
    worker!.addEventListener("error", (e: any) => reportError(e?.message ?? "worker error"));
    worker!.addEventListener("messageerror", () =>
      reportError("worker messageerror (could not deserialize a message)"),
    );
    worker!.postMessage({ t: "viewport", width: g.document.documentElement.clientWidth || 800 });
  } catch (e) {
    reportError(e instanceof Error ? e.message : String(e));
  }
}
