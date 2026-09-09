import type { HostErrorCode, SpecPatch, UISpec } from "@kohaku-ui/spec-core";

/**
 * A single event on the SSE wire (host-rest's POST /compose/stream; SPEC §6.1.1 [Draft]).
 * The spec / patch payloads are unvalidated (unknown). Typed conversion is done by {@link toComposeStreamEvent} below.
 */
export type ComposeStreamWireEvent =
  | { kind: "spec"; spec: unknown; capability?: string; final: boolean }
  | { kind: "patch"; patch: unknown }
  | { kind: "done"; specHash: string; tier: string; cache: string }
  | { kind: "error"; error: { code: string; message: string } };

/**
 * Typed Compose stream event (the shape consumed by SDK users). Corresponds to REST-STR-001..003:
 * - spec: the first event. `final: true` means the final Spec (fast path), `false` means a skeleton followed by patches.
 * - patch: applyPatch in receive order yields a Spec identical to the non-streaming /compose (REST-STR-002).
 * - done | error: terminates with exactly one (REST-STR-003). error is the host's in-band termination (a
 *   generation failure after the stream starts), and code is an error code from §6.1. A malformed body before the stream starts (400 etc.) is thrown as an exception.
 *
 * spec / patch, symmetrically with the non-streaming path (compose), "are typed but not structurally validated" —
 * validation is the responsibility of the render side (the renderer's safeParseSpec / safeParsePatch).
 */
export type ComposeStreamEvent =
  | { kind: "spec"; spec: UISpec; capability?: string; final: boolean }
  | { kind: "patch"; patch: SpecPatch }
  | { kind: "done"; specHash: string; tier: string; cache: string }
  | { kind: "error"; error: { code: HostErrorCode; message: string } };

/**
 * Parses an SSE response body (ReadableStream) into a sequence of {@link ComposeStreamWireEvent}.
 *
 * The implementation is the same SSE framing as readComposeStream inside renderer-react's useSpecStream. Because
 * the dependency direction forbids client from depending on renderer-react, this React-independent logic is
 * reimplemented here (the two wire types match; there is room to share it in the future). It handles event: / data:
 * line framing (newline-joining multi-line data, ignoring non-event/data and comment lines) and JSON.parses the
 * data per event type. Chunk-split boundaries are absorbed by TextDecoder's streaming decode and a line buffer.
 */
export async function* readComposeStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ComposeStreamWireEvent, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let dataLines: string[] = [];
  let finished = false;

  const takeFrame = (): ComposeStreamWireEvent | null => {
    if (event === "" && dataLines.length === 0) return null;
    const frame = wireEvent(event, dataLines.join("\n"));
    event = "";
    dataLines = [];
    return frame;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        buffer += decoder.decode(); // flush the multibyte boundary
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic assign-and-test loop condition (SSE line framing).
      while ((nl = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const frame = takeFrame();
          if (frame != null) yield frame;
        } else if (line.startsWith(":")) {
          // ignore comment lines (starting with :)
        } else {
          const idx = line.indexOf(":");
          const field = idx === -1 ? line : line.slice(0, idx);
          let val = idx === -1 ? "" : line.slice(idx + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "event") event = val;
          else if (field === "data") dataLines.push(val);
        }
      }
    }
    // don't drop the last event even without a trailing blank line
    const frame = takeFrame();
    if (frame != null) yield frame;
  } finally {
    // releaseLock on normal termination; on break/return mid-stream, cancel also closes the network.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => undefined);
  }
}

/** Maps an SSE frame (event name + joined data) to a ComposeStreamWireEvent. Unknown events are ignored. */
function wireEvent(event: string, data: string): ComposeStreamWireEvent | null {
  // Unknown events (including a missing event line) are ignored without parsing data (contract: unknown events are ignored).
  // This prevents JSON.parse from throwing — and the whole stream from failing — on unknown events with no data
  // (JSON.parse("")) or non-JSON data. Malformed JSON on known events still throws (the JSON.parse below).
  if (event !== "spec" && event !== "patch" && event !== "done" && event !== "error") {
    return null;
  }
  const json = JSON.parse(data) as Record<string, unknown>;
  switch (event) {
    case "spec":
      return {
        kind: "spec",
        spec: json["spec"],
        ...(typeof json["capability"] === "string" ? { capability: json["capability"] } : {}),
        final: json["final"] === true,
      };
    case "patch":
      return { kind: "patch", patch: json["patch"] };
    case "done":
      return {
        kind: "done",
        specHash: String(json["specHash"] ?? ""),
        tier: String(json["tier"] ?? ""),
        cache: String(json["cache"] ?? ""),
      };
    case "error": {
      const err = (json["error"] ?? {}) as { code?: unknown; message?: unknown };
      return {
        kind: "error",
        error: { code: String(err.code ?? "COMPOSE_FAILED"), message: String(err.message ?? "") },
      };
    }
    default:
      return null;
  }
}

/**
 * Maps a wire event to a typed event. spec / patch, symmetrically with the non-streaming path, are only typed, not structurally validated.
 * error's code is treated as an error code from §6.1 (a string on the wire, so it is mapped to HostErrorCode).
 */
export function toComposeStreamEvent(wire: ComposeStreamWireEvent): ComposeStreamEvent {
  switch (wire.kind) {
    case "spec":
      return {
        kind: "spec",
        spec: wire.spec as UISpec,
        ...(wire.capability != null ? { capability: wire.capability } : {}),
        final: wire.final,
      };
    case "patch":
      return { kind: "patch", patch: wire.patch as SpecPatch };
    case "done":
      return wire;
    case "error":
      return {
        kind: "error",
        error: { code: wire.error.code as HostErrorCode, message: wire.error.message },
      };
  }
}
