import { JsonObjectSchema, JsonValueSchema } from "@kohaku-ui/spec-core";
import { z } from "zod";

/**
 * The kohaku-sandbox/0.1 bridge protocol (JSON-RPC 2.0-like).
 * Every message is Zod-validated on both sides. Error codes:
 * -32001 RefNotAllowed / -32002 QuotaExceeded / -32003 PayloadTooLarge / -32004 RpcTimeout
 * These are this guest<->host postMessage bridge's own codes, not MCP wire error codes — they are
 * unrelated to (and do not collide with) the MCP spec's `-32000..-32019` implementation-defined /
 * `-32020..-32099` MCP-reserved server-error-range split (protocol version 2026-07-28).
 */
export const PROTOCOL = "kohaku-sandbox/0.1";

export const ERR_REF_NOT_ALLOWED = -32001;
export const ERR_QUOTA_EXCEEDED = -32002;
export const ERR_PAYLOAD_TOO_LARGE = -32003;
export const ERR_RPC_TIMEOUT = -32004;

/** guest -> host (over the MessagePort) */
export const GuestMessageSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("binding.fetch"),
    id: z.number(),
    params: z.object({ ref: z.string() }),
  }),
  z.object({
    method: z.literal("event.emit"),
    params: z.object({ on: z.string(), payload: JsonObjectSchema }),
  }),
  z.object({
    method: z.literal("ui.ready"),
  }),
  z.object({
    method: z.literal("ui.resize"),
    params: z.object({ height: z.number() }),
  }),
  z.object({
    method: z.literal("telemetry.report"),
    // The guest runtime sends "error" (synchronous error / unhandledrejection) and "denied" (the click guard
    // blocking a navigation attempt). host-bridge forwards "denied" as telemetry but must not let it flip a
    // booting widget into the error state the way a real runtime error does (see host-bridge.ts).
    params: z.object({ kind: z.enum(["error", "denied"]), detail: z.string().optional() }),
  }),
]);
export type GuestMessage = z.infer<typeof GuestMessageSchema>;

/** host -> guest (over the MessagePort) */
export const HostMessageSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("rpc.result"),
    id: z.number(),
    result: JsonValueSchema.optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
  }),
  z.object({
    method: z.literal("props.update"),
    params: z.object({ props: JsonObjectSchema }),
  }),
  z.object({
    method: z.literal("data.invalidate"),
    params: z.object({ ref: z.string() }),
  }),
  z.object({ method: z.literal("destroy") }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

/** Handshake over window (since origin checking is unusable with an opaque origin, nonce + source identity substitute for it) */
export const HandshakeReadySchema = z.object({
  kohaku: z.literal(PROTOCOL),
  method: z.literal("handshake.ready"),
  nonce: z.string().min(16),
});
export type HandshakeReady = z.infer<typeof HandshakeReadySchema>;
