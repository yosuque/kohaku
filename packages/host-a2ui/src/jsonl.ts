import type { A2uiMessage } from "./types.js";

/**
 * Serialize an A2UI message sequence into JSONL (one message per line, compact JSON) (the v0.9.1 streaming form;
 * also applies unchanged to v1.0 RC messages — the streaming form itself did not change between targets).
 *
 * A2UI streaming assumes in-order delivery, allows forward references, and buffers on the client until the root arrives.
 * Here each message becomes one line of compact JSON, joined by newlines (no trailing newline).
 */
export function serializeA2uiLines(messages: A2uiMessage[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n");
}
