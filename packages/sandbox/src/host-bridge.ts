import type { JsonValue } from "@kohaku-ui/spec-core";
import { FixedWindowLimiter, utf8ByteLength } from "./policy.js";
import {
  ERR_PAYLOAD_TOO_LARGE,
  ERR_QUOTA_EXCEEDED,
  ERR_REF_NOT_ALLOWED,
  ERR_RPC_TIMEOUT,
  GuestMessageSchema,
  type HostMessage,
} from "./protocol.js";
import type { ResolvedSandboxPolicy, SandboxBridge } from "./types.js";

export interface HostBridgeCallbacks {
  onReady(): void;
  onResize(height: number): void;
  /**
   * Delivery notification of a guest runtime error (telemetry.report kind:"error"). mount uses this to
   * "fail immediately with the real error, without waiting for the boot timeout, when a guest error occurs
   * before boot completes" (wiring independent of telemetry forwarding).
   */
  onGuestError?(detail?: string): void;
}

/** The minimal subset of MessagePort needed (a shape that can be unit-tested even with node's MessageChannel). */
export interface SandboxPortLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Sentinel used to distinguish a binding.fetch timeout from other errors in the catch clause. */
const RPC_TIMEOUT = Symbol("rpc-timeout");

/**
 * The core of the parent-side bridge (the third layer of the triple defense). It receives the MessagePort and:
 * - binding.fetch: resolves only refs that exactly match the declared $ref (violation -> -32001).
 *   If resolution exceeds policy.rpcTimeoutMs, it is aborted with -32004.
 * - event.emit: forwards upstream only declared event names (undeclared ones are dropped + telemetry).
 *   Per-minute count and payload-size quotas suppress rapid-fire (recompose storms).
 * - telemetry.report / ui.resize: per-minute count quotas suppress rapid-fire.
 * - Quotas: enforces concurrency / per-minute counts (fetch / event / telemetry / resize) / response size.
 * Implemented DOM-free so it can be unit-tested without an iframe.
 */
export class SandboxHostBridge {
  private readonly fetchLimiter: FixedWindowLimiter;
  private readonly eventLimiter: FixedWindowLimiter;
  private readonly telemetryLimiter: FixedWindowLimiter;
  private readonly resizeLimiter: FixedWindowLimiter;
  /** Rapid-fire suppression of denial telemetry notifications (once per window regardless of kind). The denial response itself is still returned. */
  private readonly deniedNotifyLimiter: FixedWindowLimiter;
  /** Flag that makes ui.ready take effect only on the first call (repeated calls from the second on are ignored). */
  private uiReadySeen = false;
  private inflight = 0;
  private closed = false;

  constructor(
    private readonly port: SandboxPortLike,
    private readonly options: {
      componentId: string;
      allowedRef?: string;
      allowedEvents: string[];
      bridge: SandboxBridge;
      policy: ResolvedSandboxPolicy;
      callbacks: HostBridgeCallbacks;
    },
  ) {
    this.fetchLimiter = new FixedWindowLimiter(options.policy.fetchesPerMinute);
    this.eventLimiter = new FixedWindowLimiter(options.policy.eventsPerMinute);
    this.telemetryLimiter = new FixedWindowLimiter(options.policy.telemetryPerMinute);
    this.resizeLimiter = new FixedWindowLimiter(options.policy.resizesPerMinute);
    // Throttle denial notifications to "once per window" regardless of kind (to keep the notifications themselves from fueling a rapid-fire loop).
    this.deniedNotifyLimiter = new FixedWindowLimiter(1);
    this.port.onmessage = (event) => {
      void this.handle(event.data);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.send({ method: "destroy" });
    this.port.close();
  }

  send(message: HostMessage): void {
    if (!this.closed) this.port.postMessage(message);
  }

  private async handle(raw: unknown): Promise<void> {
    const parsed = GuestMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.notifyDenied("malformed message");
      return;
    }
    const message = parsed.data;

    switch (message.method) {
      case "ui.ready":
        // Effective only on the first call. Repeated calls (from the second on) are ignored — because onReady involves a state transition and telemetry.
        if (this.uiReadySeen) return;
        this.uiReadySeen = true;
        this.options.callbacks.onReady();
        return;

      case "ui.resize": {
        // Rapid-fire (resize storms) is silently dropped — to avoid the notifications themselves fueling log bloat.
        if (!this.resizeLimiter.tryAcquire()) return;
        const h = message.params.height;
        // Non-finite values (NaN / Infinity) are ignored because they would produce iframe.style.height="NaNpx"
        if (Number.isFinite(h)) {
          this.options.callbacks.onResize(Math.max(0, Math.min(h, this.options.policy.maxHeightPx)));
        }
        return;
      }

      case "telemetry.report": {
        if (!this.telemetryLimiter.tryAcquire()) {
          // The excess is dropped. The denied notification is once per window (so the notification does not fuel a rapid-fire loop).
          this.notifyDenied("telemetry quota exceeded");
          return;
        }
        // detail coming from the guest is sanitized at the trust boundary: control characters are collapsed to
        // spaces and then truncated to 500 characters (suppressing tampering, bloat, and injection in downstream logs).
        const detail = message.params.detail != null ? sanitizeDetail(message.params.detail) : undefined;
        this.options.bridge.onTelemetry?.({
          componentId: this.options.componentId,
          // The guest sends "error" (runtime error) or "denied" (a click-guard block); forwarded unchanged.
          kind: message.params.kind,
          ...(detail != null ? { detail } : {}),
        });
        // Also notify mount's state machine of a guest runtime error (for immediate failure during boot).
        // A blocked click ("denied") is not a runtime error and must not flip a still-booting widget into the
        // error state.
        if (message.params.kind === "error") {
          this.options.callbacks.onGuestError?.(detail);
        }
        return;
      }

      case "event.emit": {
        const eventName = message.params.on;
        if (!this.options.allowedEvents.includes(eventName)) {
          this.notifyDenied(`undeclared event "${eventName}"`);
          return; // Undeclared events are dropped (governance)
        }
        // Oversized payloads are dropped (do not inflate downstream recompose/logs). The limit is judged by actual bytes.
        if (
          utf8ByteLength(JSON.stringify(message.params.payload)) > this.options.policy.maxEventPayloadBytes
        ) {
          this.notifyDenied(`event payload exceeds ${this.options.policy.maxEventPayloadBytes} bytes`);
          return;
        }
        // Rapid-fire (recompose storms) is dropped + a denied notification.
        if (!this.eventLimiter.tryAcquire()) {
          this.notifyDenied("event quota exceeded");
          return;
        }
        this.options.bridge.onEvent({
          componentId: this.options.componentId,
          on: eventName,
          payload: message.params.payload,
        });
        return;
      }

      case "binding.fetch": {
        const { id, params } = message;
        // allowlist: only an exact match with this node's data.$ref in the Spec
        if (this.options.allowedRef == null || params.ref !== this.options.allowedRef) {
          // The denial response (-32001) is returned every time, but only the firing of the denied notification is throttled to once per window.
          this.notifyDenied(`ref not allowed: ${params.ref.slice(0, 120)}`);
          this.send({
            method: "rpc.result",
            id,
            error: { code: ERR_REF_NOT_ALLOWED, message: "ref is not declared in the spec" },
          });
          return;
        }
        if (this.inflight >= this.options.policy.maxConcurrentFetches || !this.fetchLimiter.tryAcquire()) {
          this.send({
            method: "rpc.result",
            id,
            error: { code: ERR_QUOTA_EXCEEDED, message: "fetch quota exceeded" },
          });
          return;
        }
        this.inflight++;
        try {
          // If resolution drags on it keeps occupying an inflight slot, so it is aborted at rpcTimeoutMs.
          const result = await this.raceWithTimeout(this.options.bridge.resolveBinding(params.ref));
          const size = utf8ByteLength(JSON.stringify(result));
          if (size > this.options.policy.maxPayloadBytes) {
            this.send({
              method: "rpc.result",
              id,
              error: {
                code: ERR_PAYLOAD_TOO_LARGE,
                message: `payload exceeds ${this.options.policy.maxPayloadBytes} bytes`,
              },
            });
            return;
          }
          this.options.bridge.onTelemetry?.({ componentId: this.options.componentId, kind: "fetch" });
          this.send({ method: "rpc.result", id, result });
        } catch (e) {
          if (e === RPC_TIMEOUT) {
            this.send({
              method: "rpc.result",
              id,
              error: {
                code: ERR_RPC_TIMEOUT,
                message: `binding.fetch timed out after ${this.options.policy.rpcTimeoutMs}ms`,
              },
            });
          } else {
            // The raw error (e.g. a DomainPort exception message, which may embed internal details such as a
            // query or a stack fragment) is never forwarded into the untrusted guest — only a fixed string and
            // code go over the port. The original message still reaches the host's own observability via
            // onTelemetry, sanitized the same way guest-originated detail is (sanitizeDetail), the same
            // asymmetry S3 flagged: the guest-to-host direction was already sanitized, this closes the
            // host-to-guest direction too.
            const detail = e instanceof Error ? e.message : String(e);
            this.options.bridge.onTelemetry?.({
              componentId: this.options.componentId,
              kind: "error",
              detail: sanitizeDetail(detail),
            });
            this.send({
              method: "rpc.result",
              id,
              error: { code: -32000, message: "binding resolution failed" },
            });
          }
        } finally {
          this.inflight--;
        }
        return;
      }
    }
  }

  /**
   * Throttle the firing of denial telemetry notifications to "once per window" (rapid-fire suppression via a window counter).
   * malformed / undeclared events / disallowed ref / various quota overruns may each still return a denial response separately,
   * but to avoid the notification itself becoming fuel that bloats downstream logs, its firing is thinned out here.
   */
  private notifyDenied(detail: string): void {
    if (!this.deniedNotifyLimiter.tryAcquire()) return;
    this.options.bridge.onTelemetry?.({
      componentId: this.options.componentId,
      kind: "denied",
      // detail embeds guest-controlled strings (event name, ref), so it is sanitized at the trust boundary just like
      // telemetry.report's detail (suppressing downstream-log line spoofing and terminal-escape injection via control characters).
      detail: sanitizeDetail(detail),
    });
  }

  /** Aborts resolveBinding at policy.rpcTimeoutMs (a timeout rejects with RPC_TIMEOUT). */
  private raceWithTimeout(promise: Promise<JsonValue>): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => reject(RPC_TIMEOUT), this.options.policy.rpcTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/**
 * Sanitizes guest-originated detail. Control characters including newlines (C0 + DEL) are collapsed to spaces and then
 * truncated to 500 characters. Passing control characters straight into downstream logs could be abused for log-line
 * spoofing or terminal-escape injection, so they are stripped at the trust boundary.
 */
function sanitizeDetail(detail: string): string {
  // Intentional -- this sanitizer strips control characters (C0 + DEL) at the trust boundary; see the
  // function docstring above.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: see comment above.
  return detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}
