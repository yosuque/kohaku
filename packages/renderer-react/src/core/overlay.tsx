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
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { type ImplProps, useEmitEvent, useRenderer, useSizing, useToken } from "../context.js";

/**
 * Modal dialog (overlay.dialog). Open/close is not held in props but controlled by visibleWhen, so
 * the equation holds: this implementation being mounted = the moment it opens / unmount = the moment it closes.
 * Focus management is implemented on top of that:
 * - On open (mount): remember the launcher (the currently focused element) and move focus to the first focusable element inside the dialog.
 * - Focus trap: keep the Tab / Shift+Tab cycle within the dialog.
 * - Esc / × button / backdrop click: fire close (forwarded only when declared; normally state.set clears the open flag).
 * - On close (unmount): return focus to the launcher.
 * a11y: role="dialog" + aria-modal + aria-labelledby (title) + aria-describedby (description).
 */
export function OverlayDialog({ node, children }: ImplProps): ReactNode {
  const emit = useEmitEvent(node);
  const { theme } = useRenderer();
  const sizing = useSizing();
  const danger = String(useToken("color.danger"));
  const text = String(useToken("color.text"));
  const overlayRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const title = String(node.props["title"] ?? "");
  const description = node.props["description"] != null ? String(node.props["description"]) : null;
  const variant = (node.props["variant"] as string) ?? "default";

  const titleId = `${node.id}-title`;
  const descId = description != null ? `${node.id}-desc` : undefined;

  const close = (): void => emit("close", {});

  useEffect(() => {
    // On open: remember the launcher and move focus to the first focusable element (or the box itself if none).
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const box = boxRef.current;
    const first = box?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? box;
    first?.focus();
    return () => {
      // On close (unmount): return focus to the launcher (only if it is still in the DOM).
      const prev = restoreRef.current;
      if (prev?.isConnected) prev.focus();
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const box = boxRef.current;
    if (box == null) return;
    const focusables = [...box.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    const target = focusTrapTarget(focusables, document.activeElement as HTMLElement | null, e.shiftKey);
    if (target === "block") {
      // In a dialog with no focusable elements, do not let focus escape (keep the trap).
      e.preventDefault();
      return;
    }
    if (target != null) {
      e.preventDefault();
      target.focus();
    }
  };

  const accentBorder = variant === "danger" ? danger : "transparent";
  const titleColor = variant === "danger" ? danger : text;

  return (
    // This is the modal backdrop, not a control: onClick only dismisses on a genuine backdrop hit
    // (e.target === overlayRef.current, ignoring clicks inside the box) and onKeyDown drives the
    // Escape / focus-trap logic for the dialog as a whole. The actual interactive/labeled surface is
    // the nested div below (role="dialog" + aria-modal + aria-labelledby/describedby); giving the
    // backdrop itself an interactive role would misrepresent it as a control. renderer-wc/src/parts/overlay.ts
    // mirrors this same backdrop-click-to-dismiss pattern for React/WC parity.
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop (click-outside-to-dismiss + Esc/focus-trap), not a control -- see comment above.
    <div
      ref={overlayRef}
      data-kohaku={node.id}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // Close only on a backdrop click (the overlay itself). Ignore clicks inside the box.
        if (e.target === overlayRef.current) close();
      }}
      style={dialogOverlayStyle(theme, sizing) as CSSProperties}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={dialogBoxStyle(theme, accentBorder, sizing) as CSSProperties}
      >
        <div style={dialogHeaderStyle(sizing) as CSSProperties}>
          <h2 id={titleId} style={dialogTitleStyle(titleColor, sizing) as CSSProperties}>
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            style={dialogCloseButtonStyle(theme, sizing) as CSSProperties}
          >
            {"×"}
          </button>
        </div>
        {description != null && (
          <p id={descId} style={dialogDescriptionStyle(theme, sizing) as CSSProperties}>
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Toast notification (overlay.toast). Display is controlled by visibleWhen, and it auto-dismisses by firing dismiss after durationMs
 * (if a state.set declaration exists, it closes itself). It does not steal focus (role=status/alert only).
 * It can also be closed manually via the × button, which fires dismiss. The timer is always cleared on unmount.
 */
export function OverlayToast({ node }: ImplProps): ReactNode {
  const emit = useEmitEvent(node);
  const { theme } = useRenderer();
  const sizing = useSizing();
  // Hold emit in a ref so the timer's callback can grab the latest emit (the effect is set up once with []).
  const emitRef = useRef(emit);
  emitRef.current = emit;

  const message = String(node.props["message"] ?? "");
  const tone = (node.props["tone"] as string) ?? "info";
  const durationMs = node.props["durationMs"];
  const colors = toastToneColors(theme, tone);

  useEffect(() => {
    if (typeof durationMs !== "number") return;
    const timer = setTimeout(() => emitRef.current("dismiss", {}), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs]);

  return (
    <div data-kohaku={node.id} role={toastRole(tone)} style={toastStyle(colors, sizing) as CSSProperties}>
      <span>{message}</span>
      <button
        type="button"
        aria-label="Close"
        onClick={() => emit("dismiss", {})}
        style={toastDismissButtonStyle(sizing) as CSSProperties}
      >
        {"×"}
      </button>
    </div>
  );
}
