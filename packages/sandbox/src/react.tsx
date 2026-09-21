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
import type { DesignKitStylesheet, SandboxBridge, SandboxPolicy, SandboxState } from "./types.js";

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
   * `""` injects nothing; a bare string is the product's own kit with no version identity (trusted CSS —
   * escaped against `</style>` breakout but not otherwise sanitized, never checked against `spec.provenance.kit`,
   * the same behavior as the deprecated `kitCss` below); a `DesignKitStylesheet` additionally carries
   * `id`/`version`, compared against `spec.provenance.kit` (a mismatch is reported via
   * `bridge.onTelemetry({kind: "kit-mismatch"})` but never blocks rendering — fail-open, SPEC-KIT-001).
   *
   * Also accepts a **resolver** `(node, spec) => …`, called with this frame's own `node`/`spec` — the
   * per-node rollback hook (M-2): a host can read `spec.provenance.kit` / `spec.provenance.generatorVersion`
   * and pick a different kit for an artifact composed under an old kit than for one composed under the
   * current kit, so rolling the surface-wide kit back does not force every already-generated artifact
   * (cached / fixated / promoted) to lose its styling in lockstep — see docs/user-guide.md's design-kit
   * section for the full rollback walkthrough. The resolver is called on every render (its result, not its
   * identity, drives re-mounting — see the `kitKey` dependency below), so keep it cheap and pure; a resolver
   * returning `undefined` means "use the default kit" and `""` means "inject none", exactly like the
   * non-function forms.
   *
   * A change in the resolved value re-mounts the iframe to rebuild the srcdoc, the same as `theme`.
   */
  kit?:
    | DesignKitStylesheet
    | string
    | ((node: ComponentNode, spec: UISpec) => DesignKitStylesheet | string | undefined);
  /**
   * @deprecated Use `kit` instead (a bare string passed to `kit` is equivalent). Ignored whenever `kit` is
   * set. Kept only for backward compatibility with callers that predate `kit`.
   */
  kitCss?: string;
  /**
   * Whether the "L2 SANDBOXED" badge row (the pill + explanatory text above the iframe) is rendered.
   * Defaults to `"visible"`; set `"hidden"` only on a surface that signals sandboxing some other way —
   * hiding it removes the one on-screen cue that the content is arbitrary/generated. If a brand theme
   * overrides `color.warning.surface` / `color.warning.text` (the pair the pill and its text draw from),
   * keep that pair readable together (the pill's background against its own text), since the badge is
   * the only consumer of that pairing today.
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

  // Resolve the M-2 rollback hook: a function form of `kit` is called with this frame's own node/spec on
  // every render (see the prop's own doc comment for why that must stay cheap and pure). `undefined` here
  // means "props.kit itself is absent" (fall through to kitCss/the default), not "the resolver chose the
  // default" — a resolver that returns undefined for that reason produces the exact same undefined, and the
  // two are meant to behave identically (both mean "use the default kit").
  const resolvedKit = typeof props.kit === "function" ? props.kit(props.node, props.spec) : props.kit;
  const kitKey =
    resolvedKit === undefined
      ? ""
      : typeof resolvedKit === "string"
        ? resolvedKit
        : JSON.stringify(resolvedKit);

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
      ...(resolvedKit !== undefined ? { kit: resolvedKit } : {}),
      ...(resolvedKit === undefined && props.kitCss != null ? { kitCss: props.kitCss } : {}),
      ...(props.spec.provenance?.kit != null ? { provenanceKit: props.spec.provenance.kit } : {}),
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
    // props.kitCss is included alongside it for the same reason (it too is baked into the srcdoc) — kept
    // even though resolvedKit takes precedence over it, because a caller that only ever sets kitCss (never
    // kit) must still re-mount when its value changes (kitKey stays "" the whole time in that case, since
    // it tracks only the resolved `kit` prop). kitKey is the analogous dependency for `kit` (including its
    // resolver form): a serialized key rather than resolvedKit itself, since a resolver is commonly an
    // inline function whose reference changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact?.sha256, props.node.id, props.node.data?.$ref, themeKey, kitKey, props.kitCss]);

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
