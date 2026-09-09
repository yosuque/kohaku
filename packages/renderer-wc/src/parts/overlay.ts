import {
  dialogBoxStyle,
  dialogCloseButtonStyle,
  dialogDescriptionStyle,
  dialogHeaderStyle,
  dialogOverlayStyle,
  dialogTitleStyle,
  FOCUSABLE_SELECTOR,
  focusTrapTarget,
  toastDismissButtonStyle,
  toastRole,
  toastStyle,
  toastToneColors,
} from "@kohaku-ui/renderer-core";
import { el, text } from "../dom.js";
import type { PartBuilder } from "../types.js";
import { tokenStr } from "./kit.js";

/**
 * Gets the deepest currently-focused element within the shadow DOM (equivalent to renderer-react's document.activeElement).
 * When focus is inside a shadow root, document.activeElement points to the host element, so we traverse shadowRoots.
 */
function deepActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active != null) {
    const sr = (active as HTMLElement).shadowRoot;
    if (sr?.activeElement == null) break;
    active = sr.activeElement;
  }
  return active as HTMLElement | null;
}

/** The activeElement of the root that container belongs to (shadow root or document). Used to determine the current position for the focus trap. */
function activeInRoot(container: Node): Element | null {
  const root = container.getRootNode() as ShadowRoot | Document;
  return root.activeElement;
}

/**
 * A modal dialog (overlay.dialog, semantically equivalent to renderer-react's OverlayDialog).
 * Since open/close is handled by visibleWhen, this builder being called = the moment it opens / teardown = the moment it closes.
 * Focus management:
 * - On open: remember the launcher (the currently-focused element) and move focus to the first focusable element. The visibleWhen
 *   reactive slot (tree.ts) runs the builder on a detached container and then inserts it into the DOM, so focus is
 *   deferred to "after insertion" via queueMicrotask (insertion runs synchronously within the same task after the builder returns).
 * - Focus trap: keep the Tab / Shift+Tab cycle within the dialog (the current position is the shadow root's activeElement).
 * - Esc / × button / backdrop click: fire close (forwarded only when declared; usually toggles the open flag via state.set).
 * - On close (teardown): return focus to the launcher (only if it is still connected).
 */
export const overlayDialog: PartBuilder = (rt, parent, node, row) => {
  const danger = tokenStr(rt, "color.danger");

  const title = String(node.props["title"] ?? "");
  const description = node.props["description"] != null ? String(node.props["description"]) : null;
  const variant = (node.props["variant"] as string) ?? "default";
  const accentBorder = variant === "danger" ? danger : "transparent";
  const titleColor = variant === "danger" ? danger : tokenStr(rt, "color.text");

  const titleId = `${node.id}-title`;
  const descId = description != null ? `${node.id}-desc` : undefined;

  // Capture the launcher at build time (the synchronous moment when focus still remains on the trigger).
  const restore = deepActiveElement();

  const close = (): void => rt.emit(node, "close", {}, row);

  const overlay = el("div", { "data-kohaku": node.id }, dialogOverlayStyle);
  const box = el(
    "div",
    { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": descId },
    dialogBoxStyle(rt.theme, accentBorder),
  );
  const header = el("div", {}, dialogHeaderStyle);
  const heading = el("h2", { id: titleId }, dialogTitleStyle(titleColor));
  heading.appendChild(text(title));
  const closeBtn = el("button", { type: "button", "aria-label": "Close" }, dialogCloseButtonStyle(rt.theme));
  closeBtn.appendChild(text("×"));
  closeBtn.addEventListener("click", () => close());
  header.append(heading, closeBtn);
  box.appendChild(header);

  if (description != null) {
    const desc = el("p", { id: descId }, dialogDescriptionStyle(rt.theme));
    desc.appendChild(text(description));
    box.appendChild(desc);
  }

  overlay.appendChild(box);

  // Only a backdrop (overlay itself) click closes. Clicks inside the box are ignored.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = [...box.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    const target = focusTrapTarget(focusables, activeInRoot(box) as HTMLElement | null, e.shiftKey);
    if (target === "block") {
      e.preventDefault();
      return;
    }
    if (target != null) {
      e.preventDefault();
      target.focus();
    }
  });

  parent.appendChild(overlay);
  const childTeardown = rt.mountChildren(box, node.children, row);

  // On-open focus: run after insertion into the DOM (waits for the synchronous insertion after the builder returns).
  queueMicrotask(() => {
    if (!box.isConnected) return;
    const first = box.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? box;
    first.focus();
  });

  return () => {
    childTeardown();
    overlay.remove();
    // On close: return focus to the launcher (only if it is still connected).
    if (restore?.isConnected) restore.focus();
  };
};

/**
 * A toast notification (overlay.toast, semantically equivalent to renderer-react's OverlayToast). Visibility is controlled by visibleWhen,
 * and after durationMs elapses it fires dismiss and disappears automatically (closing itself if a state.set is declared). It does not
 * steal focus (role=status/alert only). The × button also fires dismiss. The timer is always cleared in teardown.
 */
export const overlayToast: PartBuilder = (rt, parent, node, row) => {
  const message = String(node.props["message"] ?? "");
  const tone = (node.props["tone"] as string) ?? "info";
  const durationMs = node.props["durationMs"];
  const colors = toastToneColors(rt.theme, tone);

  const toast = el("div", { "data-kohaku": node.id, role: toastRole(tone) }, toastStyle(colors));
  const label = el("span");
  label.appendChild(text(message));
  const dismissBtn = el("button", { type: "button", "aria-label": "Close" }, toastDismissButtonStyle);
  dismissBtn.appendChild(text("×"));
  dismissBtn.addEventListener("click", () => rt.emit(node, "dismiss", {}, row));
  toast.append(label, dismissBtn);
  parent.appendChild(toast);

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (typeof durationMs === "number") {
    timer = setTimeout(() => rt.emit(node, "dismiss", {}, row), durationMs);
  }

  return () => {
    if (timer != null) clearTimeout(timer);
    toast.remove();
  };
};
