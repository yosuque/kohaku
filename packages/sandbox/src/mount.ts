import { defaultDesignKit, sandboxThemeCss } from "@kohaku-ui/renderer-core";
import { SandboxHostBridge, type SandboxPortLike } from "./host-bridge.js";
import { createNavigationGuard } from "./navigation-guard.js";
import { resolvePolicy, SANDBOX_ATTRIBUTE, utf8ByteLength } from "./policy.js";
import { HandshakeReadySchema } from "./protocol.js";
import { buildSrcdoc, generateNonce, verifyArtifact } from "./srcdoc.js";
import type { MountSandboxOptions, SandboxHandle, SandboxState } from "./types.js";

/**
 * Mounts the L2 execution environment (the highest-isolation tier for freely generated HTML).
 * 1. verify the artifact sha256 -> 2. inject the srcdoc into an opaque sandbox="allow-scripts" iframe
 * 3. handshake by nonce + source identity -> transfer the MessagePort
 * 4. all subsequent communication goes through SandboxHostBridge (allowlist + quotas)
 */
export function mountSandbox(options: MountSandboxOptions): SandboxHandle {
  const policy = resolvePolicy(options.policy);
  const nonce = generateNonce();
  const listeners: ((state: SandboxState, detail?: string) => void)[] = [];
  let state: SandboxState = "loading";
  let lastDetail: string | undefined;
  let hostBridge: SandboxHostBridge | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let onLoad: (() => void) | null = null;

  const setState = (next: SandboxState, detail?: string): void => {
    if (state === "destroyed") return;
    state = next;
    lastDetail = detail;
    for (const listener of listeners) listener(next, detail);
  };

  // Tears down every live resource (timer / message listener / bridge / iframe / load listener) without touching
  // `state` — shared by the normal destroy() path (which then transitions to "destroyed") and the illegal-navigation
  // path (which instead transitions to "error", since react.tsx / renderer-wc only render the error notice for
  // state "error", not "destroyed").
  const teardown = (): void => {
    if (bootTimer != null) clearTimeout(bootTimer);
    window.removeEventListener("message", onHandshake);
    hostBridge?.close();
    if (iframe != null && onLoad != null) iframe.removeEventListener("load", onLoad);
    iframe?.remove();
  };

  const handle: SandboxHandle = {
    get state() {
      return state;
    },
    onStateChange(listener) {
      listeners.push(listener);
      // Immediately replay the current state at registration time. Errors that are settled synchronously before
      // mountSandbox returns (such as exceeding maxHtmlBytes) can only reach subscribers that register afterward
      // (react.tsx registers after the return) via this initial replay. The most recent detail is passed along too.
      listener(state, lastDetail);
    },
    updateProps(props) {
      hostBridge?.send({ method: "props.update", params: { props } });
    },
    invalidate(ref) {
      hostBridge?.send({ method: "data.invalidate", params: { ref } });
    },
    destroy() {
      teardown();
      setState("destroyed");
    },
  };

  const onHandshake = (event: MessageEvent): void => {
    // With an opaque origin, event.origin becomes "null", so we verify that the message came from this iframe
    // by source identity + nonce match.
    if (iframe == null || event.source !== iframe.contentWindow) return;
    const parsed = HandshakeReadySchema.safeParse(event.data);
    if (!parsed.success || parsed.data.nonce !== nonce) return;
    window.removeEventListener("message", onHandshake);

    const channel = new MessageChannel();
    hostBridge = new SandboxHostBridge(channel.port1 as unknown as SandboxPortLike, {
      componentId: options.componentId,
      ...(options.allowedRef != null ? { allowedRef: options.allowedRef } : {}),
      allowedEvents: options.allowedEvents,
      bridge: options.bridge,
      policy,
      callbacks: {
        onReady: () => {
          if (bootTimer != null) clearTimeout(bootTimer);
          setState("ready");
          options.bridge.onTelemetry?.({ componentId: options.componentId, kind: "ready" });
        },
        onResize: (height) => {
          if (iframe != null) iframe.style.height = `${height}px`;
        },
        onGuestError: (detail) => {
          // A guest script error before boot completes (loading) fails immediately with the real error's content,
          // without waiting for the boot timeout (default 5 seconds) — so the user sees the cause directly (e.g. the
          // TypeError message) rather than "boot timeout". A runtime error after ready does not break the already
          // rendered UI, so it does not transition state (observed via telemetry only). Forwarding of telemetry
          // kind:"error" is already done by host-bridge, so here we only perform the state transition (unlike the
          // boot-timeout path, we do not double-report).
          if (state !== "loading") return;
          if (bootTimer != null) clearTimeout(bootTimer);
          setState("error", `Script error inside the sandbox: ${detail ?? "(no details)"}`);
        },
      },
    });
    iframe.contentWindow!.postMessage(
      { method: "handshake.init", params: { props: options.initialProps ?? {} } },
      "*",
      [channel.port2],
    );
  };

  void (async () => {
    try {
      if (utf8ByteLength(options.artifact.inline) > policy.maxHtmlBytes) {
        throw new Error(`artifact exceeds maxHtmlBytes (${policy.maxHtmlBytes})`);
      }
      await verifyArtifact(options.artifact);
      // If destroy() was called during the verify await, abort here (the typical path is React StrictMode's
      // mount -> immediate cleanup -> re-mount). Without this check, the destroyed handle's iframe would be appended
      // to the container and stay alive (at destroy time the iframe is not yet created, so there is nothing to remove),
      // showing the same widget twice (a zombie iframe). We read state via handle because a direct comparison of the
      // closure variable would be rejected by TS's control-flow analysis narrowing it to "loading".
      if (handle.state === "destroyed") return;

      window.addEventListener("message", onHandshake);
      iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", SANDBOX_ATTRIBUTE);
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.setAttribute("allow", "");
      iframe.style.width = "100%";
      iframe.style.height = "320px";
      iframe.style.border = "0";
      // Theme CSS variables are always injected even when theme is unspecified (sandboxThemeCss handles the merge
      // into the default light theme). mount guarantees that the generated HTML's var(--kohaku-*) references do not
      // fall through to undefined.
      iframe.srcdoc = buildSrcdoc(
        options.artifact.inline,
        policy.csp,
        nonce,
        policy.rpcTimeoutMs,
        sandboxThemeCss(options.theme),
        options.kitCss ?? defaultDesignKit.css,
      );
      // Registered before appendChild so the guard's load counter is deterministic: jsdom (used in unit tests)
      // ignores srcdoc, loads about:blank instead, and fires "load" synchronously on attach — attaching the
      // listener first makes that synchronous load count as the initial load rather than being missed. In a real
      // browser, an iframe whose srcdoc is set before insertion (as here) fires exactly one "load" for that
      // document regardless of listener registration order, so this ordering changes nothing there.
      onLoad = createNavigationGuard(() => {
        teardown();
        setState("error", "illegal navigation inside the sandbox (guest document replaced)");
        options.bridge.onTelemetry?.({
          componentId: options.componentId,
          kind: "denied",
          detail: "illegal navigation inside the sandbox (guest document replaced)",
        });
      });
      iframe.addEventListener("load", onLoad);
      options.container.appendChild(iframe);

      bootTimer = setTimeout(() => {
        if (state === "loading") {
          setState("error", `sandbox boot timeout (${policy.bootTimeoutMs}ms)`);
          options.bridge.onTelemetry?.({
            componentId: options.componentId,
            kind: "error",
            detail: "boot timeout",
          });
        }
      }, policy.bootTimeoutMs);
    } catch (e) {
      setState("error", e instanceof Error ? e.message : String(e));
      options.bridge.onTelemetry?.({
        componentId: options.componentId,
        kind: "error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  return handle;
}
