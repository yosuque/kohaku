import {
  DEFAULT_MESSAGES,
  type RendererMessages,
  type SandboxNoticeTone,
  sandboxArtifactMissingText,
  sandboxBadgeDescriptionStyle,
  sandboxBadgeDescriptionText,
  sandboxBadgePillStyle,
  sandboxBadgeRowStyle,
  sandboxBadgeText,
  sandboxErrorNoticeText,
  sandboxLoadingNoticeText,
  sandboxNoticeBaseStyle,
  sandboxNoticeToneStyle,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode, ThemeTokens, UISpec } from "@kohaku-ui/spec-core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { mountSandbox } from "./mount.js";
import type { SandboxBridge, SandboxPolicy, SandboxState } from "./types.js";

/**
 * The React wrapper for a sandbox.html node. Used by injecting it into renderer-react's renderSandbox.
 * The capability token stays outside this component (in the parent that builds the bridge) and does not enter the iframe.
 */
export function SandboxFrame(props: {
  node: ComponentNode;
  spec: UISpec;
  bridge: SandboxBridge;
  policy?: SandboxPolicy;
  /**
   * Design tokens (injected into the srcdoc as `:root { --kohaku-* }`). Defaults to the light theme when unspecified.
   * A change in value (light/dark switch, etc.) re-mounts the iframe to rebuild the srcdoc.
   */
  theme?: ThemeTokens;
  /**
   * The design-kit stylesheet injected into the srcdoc after the theme variables and before the generated
   * CSS (so generated styles can override it). `undefined` injects renderer-core's `defaultDesignKit.css`;
   * `""` injects nothing; any other string is the product's own kit (trusted CSS — it is escaped against
   * `</style>` breakout but not otherwise sanitized). A change in value re-mounts the iframe to rebuild the
   * srcdoc, the same as `theme`.
   */
  kitCss?: string;
  /**
   * Whether the "L2 SANDBOXED" badge row (the pill + explanatory text above the iframe) is rendered.
   * Defaults to `"visible"`; `"hidden"` omits the row entirely (e.g. for a product surface that
   * signals sandboxing some other way).
   */
  badge?: "visible" | "hidden";
  /**
   * Passes the mounted sandbox's invalidate (the entry point for the data-invalidation HostMessage) up to the parent.
   * On unmount / re-mount it notifies with null. Through this, the parent can bridge the write loop's data invalidation
   * into the guest's in-place re-fetch (while the capability stays in the parent).
   */
  onHandle?: (handle: { invalidate: (ref: string) => void } | null) => void;
  /**
   * Partial override of the chrome wording (badge / notices), merged over DEFAULT_MESSAGES the same
   * way renderer-react's RendererProvider.messages / renderer-wc's context.messages work. SandboxFrame
   * cannot read those contexts directly (sandbox does not depend on renderer-react), so the host wires
   * this prop through explicitly when it wants sandbox chrome wording to follow the same i18n override.
   */
  messages?: Partial<RendererMessages>;
}): ReactNode {
  const messages: RendererMessages =
    props.messages == null ? DEFAULT_MESSAGES : { ...DEFAULT_MESSAGES, ...props.messages };
  const theme: ThemeTokens = props.theme ?? {};
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<SandboxState>("loading");
  const [detail, setDetail] = useState<string | undefined>(undefined);

  const artifact = props.node.artifact;
  const allowedEvents = props.spec.events
    .filter((e) => e.on.startsWith(`${props.node.id}.`))
    .map((e) => e.on.slice(props.node.id.length + 1));

  // Since the theme is baked into the srcdoc, a change in its content = a re-mount trigger. We compare by a serialized key
  // rather than reference identity (so passing a fresh object every render from the parent does not misfire iframe rebuilds).
  const themeKey = props.theme != null ? JSON.stringify(props.theme) : "";

  useEffect(() => {
    if (containerRef.current == null || artifact?.inline == null) return;
    const handle = mountSandbox({
      container: containerRef.current,
      componentId: props.node.id,
      artifact: { inline: artifact.inline, sha256: artifact.sha256 },
      ...(props.node.data?.$ref != null ? { allowedRef: props.node.data.$ref } : {}),
      allowedEvents,
      initialProps: props.node.props,
      bridge: props.bridge,
      ...(props.policy != null ? { policy: props.policy } : {}),
      ...(props.theme != null ? { theme: props.theme } : {}),
      ...(props.kitCss != null ? { kitCss: props.kitCss } : {}),
    });
    handle.onStateChange((next, d) => {
      setState(next);
      setDetail(d);
    });
    // Pass invalidate up to the parent (to bridge the data-invalidation bus). onHandle is not made a re-mount dependency.
    props.onHandle?.({ invalidate: (ref) => handle.invalidate(ref) });
    return () => {
      props.onHandle?.(null);
      handle.destroy();
    };
    // The re-mount trigger is the artifact identity (sha256) plus changes to node.id and data.$ref.
    // If the same HTML (same sha256) is reused for a different node / different $ref, the iframe's already-injected
    // componentId / allowedRef / allowedEvents / initialProps / bridge wiring would stay stale.
    // Including node.id and $ref as dependencies ensures it is rebuilt whenever they are swapped out.
    // (allowedEvents is derived from node.id and spec.events, so it is sufficiently covered by these two dependencies.)
    // themeKey is the dependency for rebuilding the srcdoc on a change in theme content (light/dark switch).
    // props.kitCss is included alongside it for the same reason (it too is baked into the srcdoc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact?.sha256, props.node.id, props.node.data?.$ref, themeKey, props.kitCss]);

  if (artifact?.inline == null) {
    return <Notice tone="error" text={sandboxArtifactMissingText(messages)} theme={theme} />;
  }

  return (
    <div data-kohaku={props.node.id} style={{ width: "100%" }}>
      {props.badge !== "hidden" && (
        <div style={sandboxBadgeRowStyle(theme)}>
          <span style={sandboxBadgePillStyle(theme)}>{sandboxBadgeText(messages)}</span>
          <span style={sandboxBadgeDescriptionStyle(theme)}>{sandboxBadgeDescriptionText(messages)}</span>
        </div>
      )}
      {state === "loading" && <Notice tone="info" text={sandboxLoadingNoticeText(messages)} theme={theme} />}
      {state === "error" && (
        <Notice tone="error" text={sandboxErrorNoticeText(detail, messages)} theme={theme} />
      )}
      <div ref={containerRef} style={{ width: "100%" }} />
    </div>
  );
}

function Notice({
  tone,
  text,
  theme,
}: {
  tone: SandboxNoticeTone;
  text: string;
  theme: ThemeTokens;
}): ReactNode {
  return (
    <div style={{ ...sandboxNoticeBaseStyle(theme), ...sandboxNoticeToneStyle(tone, theme) }}>{text}</div>
  );
}
