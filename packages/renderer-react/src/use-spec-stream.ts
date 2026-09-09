import { applyPatch, safeParsePatch, safeParseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One event on the SSE wire (host-rest's POST /compose/stream; SPEC §6.1.1 [Draft]).
 * The spec/patch payloads are unvalidated (unknown) — useSpecStream applies safeParseSpec / safeParsePatch.
 */
export type ComposeStreamWireEvent =
  | { kind: "spec"; spec: unknown; capability?: string; final: boolean }
  | { kind: "patch"; patch: unknown }
  | { kind: "done"; specHash: string; tier: string; cache: string }
  | { kind: "error"; error: { code: string; message: string } };

/**
 * Parses an SSE response body (ReadableStream) into a sequence of ComposeStreamWireEvent.
 * React-independent. Handles event: / data: line framing (joining multi-line data with newlines, ignoring
 * fields other than event/data and comment lines), and JSON.parse's the data per event kind.
 * Chunk-split boundaries are absorbed by TextDecoder's streaming decode and a line buffer.
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
    // Do not drop the last event even without a trailing blank line
    const frame = takeFrame();
    if (frame != null) yield frame;
  } finally {
    // On normal termination, releaseLock; if broken/returned midway, cancel also closes the network.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => undefined);
  }
}

/** Maps an SSE frame (event name + joined data) to a ComposeStreamWireEvent. Unknown events are ignored. */
function wireEvent(event: string, data: string): ComposeStreamWireEvent | null {
  // Unknown events (including those with no event line) are ignored without parsing data (contract: ignore unknown events).
  // This prevents JSON.parse from throwing on an unknown event with no data (JSON.parse("")) or non-JSON data, which would drop the whole
  // stream into STREAM_FAILED. Invalid JSON of a known event still throws and becomes an error (the JSON.parse below).
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

export type SpecStreamPhase = "idle" | "streaming" | "done" | "error";

export interface SpecStreamState {
  phase: SpecStreamPhase;
  /** The latest Spec (the finalized form after folding skeleton → patches). */
  spec?: UISpec;
  capability?: string;
  /** The done event's specHash (after finalization). */
  specHash?: string;
  error?: { code: string; message: string };
}

export interface UseSpecStreamResult extends SpecStreamState {
  /**
   * Starts the stream. request is transport DI (the same style as BindingFetcher), a function that
   * returns the fetch Response for POST /compose/stream. On re-start / unmount, the previous stream's
   * state reflection is cut off (network abort is delegated to the request side's AbortController).
   */
  start: (request: () => Promise<Response>) => void;
}

/**
 * Consumption hook for POST /compose/stream (SPEC §6.1.1 [Draft]).
 * A received spec is validated with safeParseSpec and a patch with safeParsePatch, then folded in with applyPatch
 * (validation failure becomes phase:"error"). SpecView is unchanged; it suffices to re-render the folded spec.
 *
 * Stream interruption is decided by runId generation (a design that delegates the AbortController to the caller's request).
 * This lets the caller control fetch's network side while the hook only takes on cutting off state reflection.
 * On re-start / unmount, runId is bumped and old streams' setState is discarded.
 */
export function useSpecStream(): UseSpecStreamResult {
  const [state, setState] = useState<SpecStreamState>({ phase: "idle" });
  const runIdRef = useRef(0);

  // On unmount, stop reflecting the in-progress stream's state.
  useEffect(() => () => void runIdRef.current++, []);

  const start = useCallback((request: () => Promise<Response>) => {
    const runId = ++runIdRef.current;
    const alive = (): boolean => runIdRef.current === runId;
    setState({ phase: "streaming" });

    void (async () => {
      let current: UISpec | undefined;
      try {
        const res = await request();
        if (!alive()) {
          // A response that arrived after re-start / unmount. It is not reflected in state, but leaving the Response body
          // unhandled leaks the SSE connection, so clean it up (only swallow cancel's own failure; do not change the main exception handling).
          void res.body?.cancel().catch(() => undefined);
          return;
        }
        if (!res.ok || res.body == null) {
          // An error response can also carry a body (if unconsumed, the connection lingers). Clean up similarly, then terminate.
          void res.body?.cancel().catch(() => undefined);
          setState({ phase: "error", error: { code: "STREAM_HTTP", message: `HTTP ${res.status}` } });
          return;
        }
        for await (const ev of readComposeStream(res.body)) {
          if (!alive()) return;
          if (ev.kind === "spec") {
            const parsed = safeParseSpec(ev.spec);
            if (!parsed.ok) {
              setState({
                phase: "error",
                error: { code: "SPEC_INVALID", message: parsed.zodError ?? "Spec validation failed" },
              });
              return;
            }
            current = parsed.spec;
            setState((prev) => ({
              ...prev,
              phase: "streaming",
              spec: parsed.spec,
              capability: ev.capability,
            }));
          } else if (ev.kind === "patch") {
            if (current == null) {
              setState({
                phase: "error",
                error: { code: "PATCH_WITHOUT_SPEC", message: "Received a patch before the spec" },
              });
              return;
            }
            const parsed = safeParsePatch(ev.patch);
            if (!parsed.ok) {
              setState({ phase: "error", error: { code: "PATCH_INVALID", message: parsed.zodError } });
              return;
            }
            try {
              current = applyPatch(current, parsed.patch);
            } catch (e) {
              setState({
                phase: "error",
                error: { code: "PATCH_APPLY_FAILED", message: e instanceof Error ? e.message : String(e) },
              });
              return;
            }
            const next = current;
            setState((prev) => ({ ...prev, spec: next }));
          } else if (ev.kind === "done") {
            setState((prev) => ({ ...prev, phase: "done", specHash: ev.specHash }));
            return;
          } else {
            setState({ phase: "error", error: ev.error });
            return;
          }
        }
        // If it closed without receiving either done or error, treat it as an abnormal termination.
        if (alive()) {
          setState((prev) =>
            prev.phase === "streaming"
              ? {
                  ...prev,
                  phase: "error",
                  error: {
                    code: "STREAM_INCOMPLETE",
                    message: "The stream ended without receiving done or error",
                  },
                }
              : prev,
          );
        }
      } catch (e) {
        if (alive()) {
          setState({
            phase: "error",
            error: { code: "STREAM_FAILED", message: e instanceof Error ? e.message : String(e) },
          });
        }
      }
    })();
  }, []);

  return { ...state, start };
}
