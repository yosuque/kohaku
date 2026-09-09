/**
 * The Worker-side DOM shim. `workerShimMain` is the guest closure that runs generated L2 `<script>` code: it
 * has no `document` of its own (SBX-EXEC-001) and instead exposes a virtual `document` / `window` (= `self`) /
 * `self.kohaku` that mirror just enough of the real DOM API for typical widget code, translating every
 * mutation into a short-array op relayed to the trusted iframe document (`guest/dom-applier.ts`), which is the
 * only place that actually touches the real DOM (and the only place that enforces the tag/attribute/style
 * allowlist — every op emitted here is treated as untrusted there).
 *
 * Guest convention: this file has no imports and no module-scope closures. `workerShimMain` is fully
 * self-contained (everything it needs is declared inside its own body) so that `workerShimMain.toString()`
 * yields a standalone function that can be dropped into a blob Worker or evaluated with `node:vm` in a bare
 * context exposing only `postMessage` / `addEventListener` / timers / `queueMicrotask` (see
 * test/guest/worker-shim.test.ts). Type-only imports would be fine (erased before stringification) but this
 * module does not need any.
 *
 * Deliberately reduced scope (documented rather than silently approximated):
 * - The innerHTML parser handles nesting, attributes, void elements, a handful of HTML entities, the SVG
 *   namespace switch, and <tbody> auto-insertion under <table> — it does NOT implement HTML's implied-end-tag
 *   rules (e.g. an open <p> is not auto-closed by a following block element). Malformed input either parses
 *   best-effort or throws; it never silently drops content.
 * - querySelector(All)/closest/matches support only: a tag name, `#id`, `.class`, `[attr=value]`, and the
 *   descendant/child (space / `>`) combinators — no attribute-presence-only selectors, pseudo-classes, or
 *   sibling combinators.
 * - getBoundingClientRect/clientWidth/offsetWidth/innerWidth report the document-notified viewport width with
 *   height 0; getComputedStyle returns {}; canvas 2D/WebGL contexts are unavailable (getContext returns null).
 */

/** Config passed to workerShimMain by the applier when it boots the Worker (see dom-applier.ts). */
export interface WorkerShimConfig {
  rpcTimeoutMs: number;
  /** Best-effort initial viewport width for the measurement shims (see module docstring). */
  viewportWidth: number;
  /**
   * The generated artifact's original `<body>` markup (from splitArtifact), parsed into the initial
   * document.body content before the generated `<script>` runs — the srcdoc never carries this markup itself
   * (see artifact-parts.ts / dom-applier.ts docstrings): only the Worker's own sanitizing HTML parser ever
   * turns it into DOM, as a set of ops the applier enforces the allowlist against like any other mutation.
   */
  bodyHtml: string;
}

/**
 * The guest closure itself. Do not add imports or reference anything outside this function's own body —
 * see the module docstring for why.
 */
export function workerShimMain(config: WorkerShimConfig): void {
  "use strict";
  // `self` and `globalThis` are the same object in a Worker (and self is simply absent as an ambient TS
  // global without the "webworker" lib, which cannot coexist with this package's "DOM" lib in one tsconfig —
  // see dom-applier.ts's "Typing note" for the same constraint from the document side).
  const g: any = globalThis as any;

  // --- neutralize network / import surfaces (defense in depth alongside the Worker's CSP: worker-src blob:,
  // no connect-src). Wrapped in try/catch because some of these may already be non-configurable in a given
  // engine, and a shim that cannot run at all is worse than one that leaves a redundant layer unpatched. ---
  const toNeutralize = ["importScripts", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "SharedWorker"];
  for (let i = 0; i < toNeutralize.length; i++) {
    try {
      g[toNeutralize[i]] = undefined;
    } catch (_e) {
      /* already non-configurable — the CSP still blocks the network regardless */
    }
  }

  const TELEMETRY_DETAIL_MAX_CHARS = 300; // mirrors guest/constants.ts (guest closures cannot import it)

  function send(message: unknown): void {
    g.postMessage(message);
  }

  function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) : s;
  }

  // ---------------------------------------------------------------------------------------------------
  // op batching (one flush per microtask, monotonic seq)
  // ---------------------------------------------------------------------------------------------------
  let pendingOps: unknown[][] = [];
  let flushScheduled = false;
  let seq = 0;

  function pushOp(op: unknown[]): void {
    pendingOps.push(op);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  }
  function flush(): void {
    flushScheduled = false;
    if (pendingOps.length === 0) return;
    seq += 1;
    const batch = pendingOps;
    pendingOps = [];
    send({ t: "ops", seq, ops: batch });
  }

  // ---------------------------------------------------------------------------------------------------
  // virtual node
  // ---------------------------------------------------------------------------------------------------
  let nextNodeId = 1;
  function genId(): string {
    return "n" + nextNodeId++;
  }

  interface VNode {
    id: string;
    kind: "element" | "text";
    tag: string;
    ns: string | null;
    attrs: Record<string, string>;
    styleProps: Record<string, string>;
    /** DOM-property overrides (value/checked/disabled/selected/hidden/indeterminate) — distinct from attrs. */
    props: Record<string, unknown>;
    text: string;
    parent: VNode | null;
    children: VNode[];
    listenerCounts: Record<string, number>;
    listeners: Record<string, Array<(ev: any) => void>>;
    el: any;
    /** True once this node's creation (and current attrs/style) has been emitted to the document — see ensureLive. */
    emitted: boolean;
  }

  const nodesById: Record<string, VNode> = {};

  function createVNode(kind: "element" | "text", tag: string, ns: string | null, explicitId?: string): VNode {
    const id = explicitId ?? genId();
    const node: VNode = {
      id,
      kind,
      tag,
      ns,
      attrs: {},
      styleProps: {},
      props: {},
      text: "",
      parent: null,
      children: [],
      listenerCounts: {},
      listeners: {},
      el: null,
      // The three fixed-id document anchors (html/head/body) are considered already known to the document
      // (it pre-creates them at boot — see dom-applier.ts) and never get their own "c" op.
      emitted: explicitId != null,
    };
    nodesById[id] = node;
    node.el = wrapNode(node);
    return node;
  }

  /**
   * Ensures `node` (and, recursively, whatever subtree it already has) has been created in the document.
   * A node created via document.createElement/createTextNode/innerHTML parsing starts "unemitted": no "c" op
   * is sent until it actually becomes reachable from a live anchor (html/head/body), so building a detached
   * subtree costs nothing until it is attached. Idempotent (a no-op once a node is already emitted).
   */
  function ensureLive(node: VNode): void {
    if (node.emitted) return;
    node.emitted = true;
    if (node.kind === "text") {
      pushOp(["c", node.id, "#text"]);
      pushOp(["t", node.id, node.text]);
    } else {
      pushOp(node.ns != null ? ["c", node.id, node.tag, node.ns] : ["c", node.id, node.tag]);
      for (const name of Object.keys(node.attrs)) pushOp(["s", node.id, name, node.attrs[name]]);
      for (const prop of Object.keys(node.styleProps)) pushOp(["p", node.id, prop, node.styleProps[prop]]);
      for (const prop of Object.keys(node.props)) pushOp(["y", node.id, prop, node.props[prop]]);
      if (node.children.length === 0 && node.text !== "") pushOp(["x", node.id, node.text]);
    }
    for (const child of node.children) {
      ensureLive(child);
      pushOp(["a", node.id, child.id, null]);
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // selector engine: tag / #id / .class / [attr=value], descendant (space) and child (>) combinators only
  // ---------------------------------------------------------------------------------------------------
  interface SimpleSelector {
    tag: string | null;
    id: string | null;
    classes: string[];
    attr: { name: string; value: string } | null;
  }

  function parseSimpleSelector(part: string): SimpleSelector {
    const sel: SimpleSelector = { tag: null, id: null, classes: [], attr: null };
    const re = /(^[a-zA-Z][a-zA-Z0-9-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic assign-and-test regex exec loop.
    while ((m = re.exec(part)) != null) {
      const token = m[0];
      if (token.startsWith("#")) sel.id = token.slice(1);
      else if (token.startsWith(".")) sel.classes.push(token.slice(1));
      else if (token.startsWith("[")) {
        const inner = token.slice(1, -1);
        const eq = inner.indexOf("=");
        if (eq >= 0) {
          let value = inner.slice(eq + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          sel.attr = { name: inner.slice(0, eq).trim(), value };
        } else {
          sel.attr = { name: inner.trim(), value: "" };
        }
      } else {
        sel.tag = token.toLowerCase();
      }
    }
    return sel;
  }

  function matchesSimple(node: VNode, sel: SimpleSelector): boolean {
    if (node.kind !== "element") return false;
    if (sel.tag != null && node.tag.toLowerCase() !== sel.tag) return false;
    if (sel.id != null && node.attrs["id"] !== sel.id) return false;
    if (sel.classes.length > 0) {
      const classAttr = node.attrs["class"] ?? "";
      const classList = classAttr.split(/\s+/).filter(Boolean);
      for (const c of sel.classes) if (!classList.includes(c)) return false;
    }
    if (sel.attr != null) {
      const actual = node.attrs[sel.attr.name];
      if (actual === undefined) return false;
      if (sel.attr.value !== "" && actual !== sel.attr.value) return false;
    }
    return true;
  }

  /** A parsed compound selector: a chain of simple selectors joined by descendant (null) or child (">") combinators. */
  function parseSelector(selector: string): { sel: SimpleSelector; combinator: ">" | null }[] {
    // NB: the regex has a capturing group only on the ">" branch, so a plain whitespace split leaves
    // `undefined` holes in the result (per String.prototype.split's handling of non-participating capture
    // groups) — those must be dropped, not just empty strings, or they corrupt the chain (parseSimpleSelector
    // would stringify `undefined` into the literal tag name "undefined").
    const tokens = selector
      .trim()
      .split(/\s*(>)\s*|\s+/)
      .filter((t): t is string => typeof t === "string" && t !== "");
    const chain: { sel: SimpleSelector; combinator: ">" | null }[] = [];
    let pendingCombinator: ">" | null = null;
    for (const tok of tokens) {
      if (tok === ">") {
        pendingCombinator = ">";
        continue;
      }
      chain.push({ sel: parseSimpleSelector(tok), combinator: pendingCombinator });
      pendingCombinator = null;
    }
    return chain;
  }

  function collectDescendants(node: VNode, out: VNode[]): void {
    for (const child of node.children) {
      out.push(child);
      collectDescendants(child, out);
    }
  }

  function matchesChain(node: VNode, chain: { sel: SimpleSelector; combinator: ">" | null }[]): boolean {
    let idx = chain.length - 1;
    if (!matchesSimple(node, chain[idx]!.sel)) return false;
    let current: VNode | null = node;
    idx -= 1;
    while (idx >= 0) {
      const step = chain[idx + 1]!;
      let ancestor: VNode | null = current!.parent;
      if (step.combinator === ">") {
        if (ancestor == null || !matchesSimple(ancestor, chain[idx]!.sel)) return false;
        current = ancestor;
      } else {
        let found = false;
        while (ancestor != null) {
          if (matchesSimple(ancestor, chain[idx]!.sel)) {
            found = true;
            current = ancestor;
            break;
          }
          ancestor = ancestor.parent;
        }
        if (!found) return false;
      }
      idx -= 1;
    }
    return true;
  }

  function queryAll(root: VNode, selector: string): VNode[] {
    const chain = parseSelector(selector);
    if (chain.length === 0) return [];
    const candidates: VNode[] = [];
    collectDescendants(root, candidates);
    return candidates.filter((n) => matchesChain(n, chain));
  }

  function queryFirst(root: VNode, selector: string): VNode | null {
    const chain = parseSelector(selector);
    if (chain.length === 0) return null;
    const stack: VNode[] = [...root.children];
    // depth-first, document order
    const ordered: VNode[] = [];
    collectDescendants(root, ordered);
    for (const n of ordered) {
      if (matchesChain(n, chain)) return n;
    }
    void stack;
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // innerHTML: minimal HTML parser + serializer
  // ---------------------------------------------------------------------------------------------------
  const VOID_TAGS = new Set(["br", "hr", "input"]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    apos: "'",
    nbsp: " ",
  };

  function decodeEntities(text: string): string {
    return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (whole, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        return String.fromCodePoint(parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code] ?? whole;
    });
  }

  interface ParsedNode {
    kind: "element" | "text";
    tag: string;
    attrs: [string, string][];
    children: ParsedNode[];
    text: string;
  }

  function parseHtmlFragment(html: string): ParsedNode[] {
    const root: ParsedNode = { kind: "element", tag: "#root", attrs: [], children: [], text: "" };
    const stack: ParsedNode[] = [root];
    const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    function pushText(text: string): void {
      if (text === "") return;
      stack[stack.length - 1]!.children.push({
        kind: "text",
        tag: "",
        attrs: [],
        children: [],
        text: decodeEntities(text),
      });
    }
    function currentTableContext(): ParsedNode {
      return stack[stack.length - 1]!;
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic assign-and-test regex exec loop.
    while ((m = tagRe.exec(html)) != null) {
      pushText(html.slice(lastIndex, m.index));
      lastIndex = tagRe.lastIndex;
      if (m[0].startsWith("<!--")) continue;
      if (m[1] != null) {
        // closing tag
        const tag = m[1].toLowerCase();
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i]!.tag === tag) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const tag = m[2]!.toLowerCase();
      const attrsText = m[3] ?? "";
      const selfClosing = m[4] === "/" || VOID_TAGS.has(tag);
      const attrs: [string, string][] = [];
      const attrRe = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let am: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic assign-and-test regex exec loop.
      while ((am = attrRe.exec(attrsText)) != null) {
        const name = am[1]!.toLowerCase();
        const value = am[2] ?? am[3] ?? am[4] ?? "";
        attrs.push([name, decodeEntities(value)]);
      }
      // <tbody> auto-insertion: a <tr> whose nearest open ancestor is <table> gets an implicit <tbody>.
      let parent = currentTableContext();
      if (tag === "tr" && parent.tag === "table") {
        let tbody = parent.children[parent.children.length - 1];
        if (tbody == null || tbody.kind !== "element" || tbody.tag !== "tbody") {
          tbody = { kind: "element", tag: "tbody", attrs: [], children: [], text: "" };
          parent.children.push(tbody);
        }
        stack.push(tbody);
        parent = tbody;
      }
      const node: ParsedNode = { kind: "element", tag, attrs, children: [], text: "" };
      parent.children.push(node);
      if (!selfClosing) stack.push(node);
    }
    pushText(html.slice(lastIndex));
    return root.children;
  }

  function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeAttr(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function serialize(node: VNode): string {
    if (node.kind === "text") return escapeHtml(node.text);
    const attrParts: string[] = [];
    for (const name of Object.keys(node.attrs)) {
      attrParts.push(`${name}="${escapeAttr(node.attrs[name]!)}"`);
    }
    const styleKeys = Object.keys(node.styleProps);
    if (styleKeys.length > 0) {
      const cssText = styleKeys.map((k) => `${k}:${node.styleProps[k]}`).join(";");
      attrParts.push(`style="${escapeAttr(cssText)}"`);
    }
    const open = attrParts.length > 0 ? `<${node.tag} ${attrParts.join(" ")}>` : `<${node.tag}>`;
    if (VOID_TAGS.has(node.tag)) return open;
    const inner = node.children.map(serialize).join("");
    return `${open}${inner}</${node.tag}>`;
  }

  // ---------------------------------------------------------------------------------------------------
  // mutation emission
  // ---------------------------------------------------------------------------------------------------
  function removeFromParent(node: VNode): void {
    if (node.parent == null) return;
    const oldParent = node.parent;
    const idx = oldParent.children.indexOf(node);
    if (idx >= 0) oldParent.children.splice(idx, 1);
    node.parent = null;
    if (node.emitted && oldParent.emitted) pushOp(["r", oldParent.id, node.id]);
  }

  function appendChildInternal(parent: VNode, child: VNode, beforeId: string | null): void {
    if (child.parent != null) removeFromParent(child);
    if (beforeId != null) {
      const beforeIdx = parent.children.findIndex((c) => c.id === beforeId);
      parent.children.splice(beforeIdx < 0 ? parent.children.length : beforeIdx, 0, child);
    } else {
      parent.children.push(child);
    }
    child.parent = parent;
    if (parent.emitted) {
      ensureLive(child); // a no-op if child is already live; otherwise emits its whole (still-detached) subtree first
      pushOp(["a", parent.id, child.id, beforeId]);
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // element / text wrapper (the object returned to generated code)
  // ---------------------------------------------------------------------------------------------------
  function materialize(parsed: ParsedNode, ns: string | null): VNode {
    if (parsed.kind === "text") {
      const node = createVNode("text", "#text", null);
      node.text = parsed.text;
      return node;
    }
    const childNs = parsed.tag === "svg" ? SVG_NS : ns;
    const node = createVNode("element", parsed.tag, childNs);
    for (const [name, value] of parsed.attrs) {
      node.attrs[name] = value;
    }
    for (const child of parsed.children) {
      const childNode = materialize(child, childNs);
      childNode.parent = node;
      node.children.push(childNode);
    }
    return node;
  }

  function clearChildren(node: VNode): void {
    for (const child of [...node.children]) {
      removeFromParent(child);
    }
  }

  function setInnerHtml(node: VNode, html: string): void {
    clearChildren(node);
    const parsedChildren = parseHtmlFragment(html);
    for (const parsed of parsedChildren) {
      const child = materialize(parsed, node.ns);
      appendChildInternal(node, child, null);
    }
  }

  function wrapNode(node: VNode): any {
    const el: any = {};
    Object.defineProperty(el, "nodeType", { get: () => (node.kind === "text" ? 3 : 1) });
    Object.defineProperty(el, "tagName", { get: () => node.tag.toUpperCase() });
    Object.defineProperty(el, "parentNode", { get: () => node.parent?.el ?? null });
    Object.defineProperty(el, "parentElement", { get: () => node.parent?.el ?? null });
    Object.defineProperty(el, "children", {
      get: () => node.children.filter((c) => c.kind === "element").map((c) => c.el),
    });
    Object.defineProperty(el, "childNodes", { get: () => node.children.map((c) => c.el) });
    Object.defineProperty(el, "firstChild", { get: () => node.children[0]?.el ?? null });
    Object.defineProperty(el, "lastChild", {
      get: () => node.children[node.children.length - 1]?.el ?? null,
    });
    Object.defineProperty(el, "nextSibling", {
      get: () => {
        if (node.parent == null) return null;
        const idx = node.parent.children.indexOf(node);
        return node.parent.children[idx + 1]?.el ?? null;
      },
    });
    Object.defineProperty(el, "previousSibling", {
      get: () => {
        if (node.parent == null) return null;
        const idx = node.parent.children.indexOf(node);
        return idx > 0 ? node.parent.children[idx - 1]!.el : null;
      },
    });

    Object.defineProperty(el, "id", {
      get: () => node.attrs["id"] ?? "",
      set: (v: string) => {
        node.attrs["id"] = String(v);
        if (node.emitted) pushOp(["s", node.id, "id", String(v)]);
      },
    });
    Object.defineProperty(el, "className", {
      get: () => node.attrs["class"] ?? "",
      set: (v: string) => {
        node.attrs["class"] = String(v);
        if (node.emitted) pushOp(["s", node.id, "class", String(v)]);
      },
    });
    Object.defineProperty(el, "title", {
      get: () => node.attrs["title"] ?? "",
      set: (v: string) => {
        node.attrs["title"] = String(v);
        if (node.emitted) pushOp(["s", node.id, "title", String(v)]);
      },
    });
    for (const prop of ["value", "checked", "disabled", "selected", "hidden", "indeterminate"]) {
      Object.defineProperty(el, prop, {
        get: () => node.props[prop] ?? (prop === "checked" || prop === "disabled" ? false : ""),
        set: (v: unknown) => {
          node.props[prop] = v;
          if (node.emitted) pushOp(["y", node.id, prop, v]);
        },
      });
    }
    Object.defineProperty(el, "tabIndex", {
      get: () => Number(node.attrs["tabindex"] ?? -1),
      set: (v: number) => {
        node.attrs["tabindex"] = String(v);
        if (node.emitted) pushOp(["s", node.id, "tabindex", String(v)]);
      },
    });

    Object.defineProperty(el, "textContent", {
      get: () => (node.kind === "text" || node.children.length > 0 ? textOf(node) : node.text),
      set: (v: unknown) => {
        const text = v == null ? "" : String(v);
        if (node.kind === "text") {
          node.text = text;
          if (node.emitted) pushOp(["t", node.id, text]);
          return;
        }
        clearChildren(node);
        node.text = text;
        if (node.emitted) pushOp(["x", node.id, text]);
      },
    });
    Object.defineProperty(el, "innerText", {
      get: () => el.textContent,
      set: (v: unknown) => {
        el.textContent = v;
      },
    });
    Object.defineProperty(el, "innerHTML", {
      get: () => (node.kind === "text" ? "" : node.children.map(serialize).join("")),
      set: (v: unknown) => setInnerHtml(node, v == null ? "" : String(v)),
    });

    const styleProxy = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "setProperty") {
            return (name: string, value: string) => setStyleProp(name, value);
          }
          if (prop === "removeProperty") {
            return (name: string) => setStyleProp(name, "");
          }
          if (prop === "cssText") {
            return Object.keys(node.styleProps)
              .map((k) => `${k}: ${node.styleProps[k]}`)
              .join("; ");
          }
          return node.styleProps[kebab(prop)] ?? "";
        },
        set(_t, prop: string, value: unknown) {
          if (prop === "cssText") {
            node.styleProps = {};
            const text = String(value);
            for (const decl of text.split(";")) {
              const idx = decl.indexOf(":");
              if (idx < 0) continue;
              setStyleProp(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
            }
            return true;
          }
          setStyleProp(prop, String(value));
          return true;
        },
      },
    );
    function kebab(prop: string): string {
      return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    }
    function setStyleProp(name: string, value: string): void {
      const kebabName = kebab(name);
      if (value === "") {
        delete node.styleProps[kebabName];
      } else {
        node.styleProps[kebabName] = value;
      }
      if (node.emitted) pushOp(["p", node.id, kebabName, value]);
    }
    Object.defineProperty(el, "style", { get: () => styleProxy });

    const classListApi = {
      add: (...names: string[]) => {
        const set = new Set((node.attrs["class"] ?? "").split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        el.className = [...set].join(" ");
      },
      remove: (...names: string[]) => {
        const set = new Set((node.attrs["class"] ?? "").split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        el.className = [...set].join(" ");
      },
      toggle: (name: string, force?: boolean) => {
        const set = new Set((node.attrs["class"] ?? "").split(/\s+/).filter(Boolean));
        const has = set.has(name);
        const shouldHave = force == null ? !has : force;
        if (shouldHave) set.add(name);
        else set.delete(name);
        el.className = [...set].join(" ");
        return shouldHave;
      },
      contains: (name: string) => (node.attrs["class"] ?? "").split(/\s+/).filter(Boolean).includes(name),
    };
    Object.defineProperty(el, "classList", { get: () => classListApi });

    const datasetProxy = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return node.attrs[`data-${kebab(prop)}`];
        },
        set(_t, prop: string, value: unknown) {
          const name = `data-${kebab(prop)}`;
          node.attrs[name] = String(value);
          if (node.emitted) pushOp(["s", node.id, name, String(value)]);
          return true;
        },
      },
    );
    Object.defineProperty(el, "dataset", { get: () => datasetProxy });

    el.setAttribute = (name: string, value: unknown) => {
      const v = String(value);
      node.attrs[String(name).toLowerCase()] = v;
      if (node.emitted) pushOp(["s", node.id, String(name).toLowerCase(), v]);
    };
    el.setAttributeNS = (ns: string | null, name: string, value: unknown) => {
      const v = String(value);
      node.attrs[String(name).toLowerCase()] = v;
      if (node.emitted) pushOp(["s", node.id, String(name).toLowerCase(), v, ns ?? undefined]);
    };
    el.getAttribute = (name: string) => node.attrs[String(name).toLowerCase()] ?? null;
    el.hasAttribute = (name: string) =>
      Object.prototype.hasOwnProperty.call(node.attrs, String(name).toLowerCase());
    el.removeAttribute = (name: string) => {
      delete node.attrs[String(name).toLowerCase()];
      if (node.emitted) pushOp(["s", node.id, String(name).toLowerCase(), null]);
    };

    el.appendChild = (child: any) => {
      appendChildInternal(node, resolveNode(child), null);
      return child;
    };
    el.append = (...items: any[]) => {
      for (const item of items) {
        const child = typeof item === "string" ? createTextNodeWrapper(item) : item;
        appendChildInternal(node, resolveNode(child), null);
      }
    };
    el.prepend = (...items: any[]) => {
      const beforeId = node.children[0]?.id ?? null;
      for (const item of items) {
        const child = typeof item === "string" ? createTextNodeWrapper(item) : item;
        appendChildInternal(node, resolveNode(child), beforeId);
      }
    };
    el.insertBefore = (child: any, ref: any) => {
      appendChildInternal(node, resolveNode(child), ref == null ? null : resolveNode(ref).id);
      return child;
    };
    el.removeChild = (child: any) => {
      removeFromParent(resolveNode(child));
      return child;
    };
    el.remove = () => removeFromParent(node);
    el.replaceChild = (newChild: any, oldChild: any) => {
      const beforeId = resolveNode(oldChild).id;
      const oldNode = resolveNode(oldChild);
      const idx = node.children.indexOf(oldNode);
      const nextSiblingId = node.children[idx + 1]?.id ?? null;
      removeFromParent(oldNode);
      appendChildInternal(node, resolveNode(newChild), nextSiblingId);
      void beforeId;
      return oldChild;
    };
    el.replaceChildren = (...items: any[]) => {
      clearChildren(node);
      for (const item of items) {
        const child = typeof item === "string" ? createTextNodeWrapper(item) : item;
        appendChildInternal(node, resolveNode(child), null);
      }
    };
    el.replaceWith = (...items: any[]) => {
      const parent = node.parent;
      if (parent == null) return;
      const idx = parent.children.indexOf(node);
      const beforeId = parent.children[idx + 1]?.id ?? null;
      removeFromParent(node);
      for (const item of items) {
        const child = typeof item === "string" ? createTextNodeWrapper(item) : item;
        appendChildInternal(parent, resolveNode(child), beforeId);
      }
    };
    el.contains = (other: any) => {
      let n: VNode | null = resolveNode(other);
      while (n != null) {
        if (n === node) return true;
        n = n.parent;
      }
      return false;
    };
    el.cloneNode = (deep?: boolean) => {
      if (node.kind === "text") {
        const clone = createVNode("text", "#text", null);
        clone.text = node.text;
        return clone.el;
      }
      const clone = createVNode("element", node.tag, node.ns);
      clone.attrs = { ...node.attrs };
      clone.styleProps = { ...node.styleProps };
      if (deep === true) {
        for (const child of node.children) {
          const childClone = resolveNode(child.el.cloneNode(true));
          childClone.parent = clone;
          clone.children.push(childClone);
        }
      }
      return clone.el;
    };

    el.querySelector = (selector: string) => queryFirst(node, selector)?.el ?? null;
    el.querySelectorAll = (selector: string) => queryAll(node, selector).map((n) => n.el);
    el.getElementsByClassName = (cls: string) => queryAll(node, `.${cls}`).map((n) => n.el);
    el.getElementsByTagName = (tag: string) => queryAll(node, tag).map((n) => n.el);
    el.closest = (selector: string) => {
      const chain = parseSelector(selector);
      let current: VNode | null = node;
      while (current != null) {
        if (matchesChain(current, chain)) return current.el;
        current = current.parent;
      }
      return null;
    };
    el.matches = (selector: string) => matchesChain(node, parseSelector(selector));

    el.addEventListener = (type: string, handler: (ev: any) => void) => {
      if (typeof handler !== "function") return;
      node.listeners[type] ??= [];
      const list = node.listeners[type];
      if (list.includes(handler)) return;
      list.push(handler);
      node.listenerCounts[type] = (node.listenerCounts[type] ?? 0) + 1;
      if (node.listenerCounts[type] === 1) pushOp(["l", node.id, type]);
    };
    el.removeEventListener = (type: string, handler: (ev: any) => void) => {
      const list = node.listeners[type];
      if (list == null) return;
      const idx = list.indexOf(handler);
      if (idx < 0) return;
      list.splice(idx, 1);
      node.listenerCounts[type] = Math.max(0, (node.listenerCounts[type] ?? 1) - 1);
      if (node.listenerCounts[type] === 0) pushOp(["u", node.id, type]);
    };
    el.dispatchEvent = (event: any) => {
      dispatchLocal(node, event?.type ?? "", event ?? {});
      return true;
    };
    el.focus = () => pushOp(["f", node.id]);
    el.blur = () => {
      /* no real-DOM equivalent op is defined for blur (reduced scope, see module docstring) */
    };
    el.scrollIntoView = () => {
      /* no real-DOM equivalent op is defined for scrollIntoView (reduced scope, see module docstring) */
    };

    Object.defineProperty(el, "clientWidth", { get: () => config.viewportWidth });
    Object.defineProperty(el, "offsetWidth", { get: () => config.viewportWidth });
    Object.defineProperty(el, "clientHeight", { get: () => 0 });
    Object.defineProperty(el, "offsetHeight", { get: () => 0 });
    Object.defineProperty(el, "scrollTop", {
      get: () => 0,
      set: (v: number) => {
        if (node.emitted) pushOp(["y", node.id, "scrollTop", v]);
      },
    });
    Object.defineProperty(el, "scrollLeft", {
      get: () => 0,
      set: (v: number) => {
        if (node.emitted) pushOp(["y", node.id, "scrollLeft", v]);
      },
    });
    el.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: config.viewportWidth,
      bottom: 0,
      width: config.viewportWidth,
      height: 0,
      toJSON() {
        return this;
      },
    });
    el.getContext = () => null; // canvas 2D/WebGL is unavailable (reduced scope, see module docstring)

    Object.defineProperty(el, "__kohakuNode", { value: node });
    return el;
  }

  function textOf(node: VNode): string {
    return node.kind === "text" ? node.text : node.children.map(textOf).join("");
  }

  function resolveNode(wrapper: any): VNode {
    const node = wrapper?.__kohakuNode as VNode | undefined;
    if (node == null) throw new TypeError("expected a node created by this document");
    return node;
  }

  function createTextNodeWrapper(text: string): any {
    const node = createVNode("text", "#text", null);
    node.text = text;
    return node.el;
  }

  // ---------------------------------------------------------------------------------------------------
  // event dispatch (bubbling through the local virtual tree; used both for locally-raised dispatchEvent
  // and for real DOM events the document forwards)
  // ---------------------------------------------------------------------------------------------------
  function dispatchLocal(target: VNode, type: string, fields: Record<string, unknown>): void {
    let stopped = false;
    let immediateStopped = false;
    const event: any = {
      type,
      target: target.el,
      currentTarget: null,
      bubbles: true,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      stopImmediatePropagation() {
        stopped = true;
        immediateStopped = true;
      },
      ...fields,
    };
    let current: VNode | null = target;
    while (current != null && !stopped) {
      event.currentTarget = current.el;
      const list = current.listeners[type];
      if (list != null) {
        for (const handler of [...list]) {
          if (immediateStopped) break;
          try {
            handler(event);
          } catch (e) {
            reportError(e);
          }
        }
      }
      current = current.parent;
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // document / window shims
  // ---------------------------------------------------------------------------------------------------
  // Fixed ids ("html"/"head"/"body") rather than the "n<N>" auto-generated sequence, so the document side can
  // pre-map these three anchors to its own real elements at boot without waiting for a "c" op (see dom-applier.ts).
  const htmlNode = createVNode("element", "html", null, "html");
  const headNode = createVNode("element", "head", null, "head");
  const bodyNode = createVNode("element", "body", null, "body");
  htmlNode.children.push(headNode, bodyNode);
  headNode.parent = htmlNode;
  bodyNode.parent = htmlNode;

  const documentShim: any = {
    body: bodyNode.el,
    documentElement: htmlNode.el,
    head: headNode.el,
    createElement: (tag: string) => createVNode("element", String(tag).toLowerCase(), null).el,
    createElementNS: (ns: string, tag: string) => createVNode("element", String(tag).toLowerCase(), ns).el,
    createTextNode: (data: unknown) => createTextNodeWrapper(data == null ? "" : String(data)),
    createDocumentFragment: () => {
      // A fragment is modeled as a bare element wrapper (#fragment) never itself appended: appendChild on it
      // moves children in immediately the same way a real DocumentFragment does on append to a real parent.
      return createVNode("element", "#fragment", null).el;
    },
    getElementById: (id: string) => {
      const found = queryAll(htmlNode, `#${id}`);
      return found[0]?.el ?? null;
    },
    querySelector: (selector: string) => queryFirst(htmlNode, selector)?.el ?? null,
    querySelectorAll: (selector: string) => queryAll(htmlNode, selector).map((n) => n.el),
    getElementsByClassName: (cls: string) => queryAll(htmlNode, `.${cls}`).map((n) => n.el),
    getElementsByTagName: (tag: string) => queryAll(htmlNode, tag).map((n) => n.el),
    addEventListener: (type: string, handler: (ev: any) => void) =>
      htmlNode.el.addEventListener(type, handler),
    removeEventListener: (type: string, handler: (ev: any) => void) =>
      htmlNode.el.removeEventListener(type, handler),
  };
  Object.defineProperty(documentShim, "title", {
    get: () => "",
    set: () => {
      /* no-op: the host derives the display title from the original artifact's <title>, not runtime writes */
    },
  });
  // Getter-only (no setter): SBX-EXEC-001 requires "no assignable location" — a plain missing property would
  // let `document.location = "..."` silently create a harmless own property, but a getter-only accessor makes
  // the assignment itself throw a TypeError in this "use strict" scope, which is the stronger, unambiguous
  // guarantee. document.cookie / document.write / document.open are simply never defined at all (reading them
  // is `undefined`, matching worker-shim.test.ts's expectations), since nothing needs to reject writing them —
  // there is no navigable/persistent side effect they could have here either way.
  Object.defineProperty(documentShim, "location", { get: () => undefined });

  g.document = documentShim;
  g.window = g;

  // The artifact's original body markup, if any, is parsed into the initial DOM before the generated
  // <script> below runs (mirroring how a real browser parses <body>...<script> in document order).
  if (config.bodyHtml !== "") {
    setInnerHtml(bodyNode, config.bodyHtml);
  }

  // ---------------------------------------------------------------------------------------------------
  // self.kohaku bridge (fetchData / emit / onProps / ready)
  // ---------------------------------------------------------------------------------------------------
  let rpcId = 0;
  const pending: Record<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
  > = {};
  const propsListeners: Array<(props: unknown, ref?: string) => void> = [];
  let readySent = false;

  function rejectAllPending(reason: string): void {
    for (const key of Object.keys(pending)) {
      const p = pending[key as unknown as number]!;
      clearTimeout(p.timer);
      delete pending[key as unknown as number];
      try {
        p.reject(new Error(reason));
      } catch (_e) {
        /* a rejection handler throwing must not break teardown of the remaining pending entries */
      }
    }
  }

  g.kohaku = {
    fetchData(ref: unknown) {
      return new Promise((resolve, reject) => {
        const id = ++rpcId;
        const timer = setTimeout(() => {
          if (pending[id]) {
            delete pending[id];
            reject(new Error("rpc timeout"));
          }
        }, config.rpcTimeoutMs);
        pending[id] = { resolve, reject, timer };
        send({ t: "rpc", id, ref: String(ref) });
      });
    },
    emit(on: unknown, payload: unknown) {
      send({ t: "event", on: String(on), payload: payload ?? {} });
    },
    onProps(cb: (props: unknown, ref?: string) => void) {
      propsListeners.push(cb);
    },
    ready() {
      if (readySent) return;
      readySent = true;
      pushOp(["R"]);
    },
  };

  function reportError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    send({ t: "telemetry", kind: "error", detail: truncate(message, TELEMETRY_DETAIL_MAX_CHARS) });
  }

  g.addEventListener("error", (event: any) => {
    reportError(event?.error ?? event?.message ?? "Unknown error");
  });
  g.addEventListener("unhandledrejection", (event: any) => {
    reportError(event?.reason ?? "Unhandled rejection");
  });

  // ---------------------------------------------------------------------------------------------------
  // measurement / feature shims that are always unavailable (see module docstring)
  // ---------------------------------------------------------------------------------------------------
  g.MutationObserver = undefined;
  g.IntersectionObserver = undefined;
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
  g.getComputedStyle = () => ({});
  g.alert = undefined;
  g.confirm = undefined;
  g.prompt = undefined;
  g.localStorage = undefined;
  g.sessionStorage = undefined;
  g.indexedDB = undefined;

  // ---------------------------------------------------------------------------------------------------
  // messages from the document (rpc-result / props / invalidate / dom-event / viewport / destroy)
  // ---------------------------------------------------------------------------------------------------
  g.addEventListener("message", (event: any) => {
    const msg = event?.data;
    if (msg == null || typeof msg !== "object") return;
    switch (msg.t) {
      case "rpc-result": {
        const p = pending[msg.id];
        if (p == null) return;
        clearTimeout(p.timer);
        delete pending[msg.id];
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      case "props": {
        for (const cb of propsListeners) {
          try {
            cb(msg.props);
          } catch (_e) {
            /* a widget's own onProps callback throwing must not break delivery to other listeners */
          }
        }
        return;
      }
      case "invalidate": {
        for (const cb of propsListeners) {
          try {
            cb(null, msg.ref);
          } catch (_e) {
            /* same as "props" above */
          }
        }
        return;
      }
      case "dom-event": {
        const node = nodesById[msg.targetId];
        if (node == null) return;
        const { t: _t, targetId: _targetId, type, ...fields } = msg;
        dispatchLocal(node, type, fields);
        return;
      }
      case "viewport": {
        config.viewportWidth = msg.width;
        return;
      }
      case "destroy": {
        rejectAllPending("sandbox destroyed");
        return;
      }
      default:
        return;
    }
  });
}

/**
 * A shim for esbuild's `__name(fn, name)` helper (injected by the "keep names across minification" transform
 * for every function/arrow-function declaration it sees, including nested ones — confirmed against tsx, which
 * is how cli/bin/kohaku.js runs this at build time). The helper's *call sites* end up inside
 * `workerShimMain.toString()` (and `domApplierMain.toString()`) since they are nested inside those functions,
 * but its *definition* lives at that compiled file's module scope, which `.toString()` never captures — so a
 * bare `__name(...)` call would throw `ReferenceError: __name is not defined` in whatever environment
 * ultimately evaluates the guest closure's stringified source, unless something defines it first. Prepending
 * this (as plain text, so esbuild's own transform of *this* file never touches it) makes the guest closures
 * evaluable regardless of which compiler (or none) produced their `.toString()` output.
 */
export const NAME_HELPER_SHIM = "self.__name = self.__name || function (fn) { return fn; };\n";

/**
 * Builds the standalone JS source that boots the Worker: `workerShimMain`'s own source plus an invocation
 * with `config`. Not a guest closure itself (it is never stringified further) — a plain helper used by
 * dom-applier.ts (embedded into the trusted document's own inline script) and by tests.
 */
export function buildWorkerShimJs(config: WorkerShimConfig): string {
  return `${NAME_HELPER_SHIM}(${workerShimMain.toString()})(${JSON.stringify(config)});`;
}
