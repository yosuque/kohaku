import { type SurfaceEvent, useSpecStream } from "@kohaku-ui/renderer-react";
import type { CanonicalIntent } from "@kohaku-ui/spec-core";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../i18n/ui.js";
import { type ComposeView, composeStreamRequest, normalizeNl, sendEvent } from "../kohaku/client.js";
import { ProvenanceBadge } from "../kohaku/ProvenanceBadge.js";
import { SpecJsonDrawer } from "../kohaku/SpecJsonDrawer.js";
import { SpecSurface } from "../kohaku/SpecSurface.js";
import { useLatestRequest } from "../kohaku/useLatestRequest.js";
import { ErrorBanner } from "./admin/ui.js";

interface UserItem {
  id: number;
  role: "user";
  text: string;
}

interface AssistantItem {
  id: number;
  role: "assistant";
  /** normalizing = normalizing / ready = ready to start streaming / error = normalization failed */
  status: "normalizing" | "ready" | "error";
  intent?: CanonicalIntent;
  source?: "llm" | "deterministic";
  /** A fetch thunk to POST /compose/stream (passed to useSpecStream). */
  request?: () => Promise<Response>;
  error?: string;
}

type ChatItem = UserItem | AssistantItem;

/**
 * The NLUI surface. Natural language → normalized Intent (made transparent via a chip) → the same
 * Composition Service → the same Spec → the same SpecSurface.
 * The same question as on the Dashboard yields the same intentHash and cache:HIT (the R5 demo).
 *
 * Composition is done via streaming (POST /compose/stream): a skeleton (ui.loading) is drawn immediately and
 * replaced with the final form once generation completes. The non-stream path (/compose) used by Dashboard etc. stays as-is.
 *
 * Language toggle policy: existing bubbles keep the language they were composed in (mirrors real
 * chat products and avoids replaying the whole session); chips/placeholder/status text switch
 * instantly, and the next question is normalized+composed in the new language.
 */
export function ChatPage(): ReactNode {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const sessionId = useMemo(() => `chat-${Math.random().toString(36).slice(2, 10)}`, []);
  const t = useT();

  const patch = (id: number, update: Partial<AssistantItem>): void => {
    setItems((prev) =>
      prev.map((item) => (item.id === id && item.role === "assistant" ? { ...item, ...update } : item)),
    );
  };

  const ask = async (text: string): Promise<void> => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setInput("");
    const userId = nextId.current++;
    const assistantId = nextId.current++;
    setItems((prev) => [
      ...prev,
      { id: userId, role: "user", text },
      { id: assistantId, role: "assistant", status: "normalizing" },
    ]);

    try {
      // (1) Normalization (LLM) — merge into the same representation as GUI operations, made transparent by the Intent chip.
      const { intent, source } = await normalizeNl(text, sessionId);
      // (2) Composition just passes the streaming-start thunk. The actual start is done by StreamingAssistant.
      patch(assistantId, {
        status: "ready",
        intent,
        source,
        request: composeStreamRequest({
          intent: { canonical: intent.canonical, params: intent.params },
          session: { surface: "chat", sessionId },
        }),
      });
    } catch (e) {
      patch(assistantId, { status: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "20px 20px 120px" }}>
      {items.length === 0 && (
        <div
          style={{
            color: "var(--app-muted, #6b7280)",
            textAlign: "center",
            padding: "60px 0 20px",
            fontSize: 14,
          }}
        >
          {t.chat.empty1}
          <br />
          {t.chat.empty2}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {items.map((item) =>
          item.role === "user" ? (
            <div key={item.id} style={{ alignSelf: "flex-end", maxWidth: "75%" }}>
              <div
                style={{
                  background: "var(--app-primary, #4f46e5)",
                  color: "#fff",
                  borderRadius: "14px 14px 4px 14px",
                  padding: "10px 14px",
                  fontSize: 14,
                }}
              >
                {item.text}
              </div>
            </div>
          ) : (
            <AssistantMessage key={item.id} item={item} sessionId={sessionId} />
          ),
        )}
      </div>

      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "linear-gradient(transparent, var(--app-canvas, #f5f6fa) 30%)",
          padding: "24px 20px 18px",
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {t.chat.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void ask(s)}
                disabled={busy}
                style={{
                  border: "1px solid var(--app-border, #e5e7eb)",
                  background: "var(--app-elevated, #fff)",
                  borderRadius: 999,
                  padding: "5px 12px",
                  fontSize: 12,
                  cursor: busy ? "default" : "pointer",
                  color: "var(--app-subtle, #475569)",
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t.chat.placeholder}
              style={{
                flex: 1,
                border: "1px solid var(--app-border, #e5e7eb)",
                borderRadius: 10,
                padding: "12px 14px",
                fontSize: 14,
                background: "var(--app-elevated, #fff)",
                color: "var(--app-text, #1a1a2e)",
              }}
            />
            <button
              type="submit"
              disabled={busy || input.trim() === ""}
              style={{
                background: busy ? "#a5b4fc" : "var(--app-primary, #4f46e5)",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "0 22px",
                fontSize: 14,
                fontWeight: 650,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "…" : t.chat.send}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// memo()'d: `patch()` in ChatPage replaces only the updated item in `items`, so unrelated messages
// keep the same `item` object reference across a setItems call — the default shallow prop comparison
// is enough to stop every earlier message in a long conversation from re-rendering (and re-running
// StreamingAssistant's own subtree) each time a new message streams in.
const AssistantMessage = memo(function AssistantMessage(props: {
  item: AssistantItem;
  sessionId: string;
}): ReactNode {
  const { item } = props;
  const t = useT();
  return (
    <div style={{ alignSelf: "stretch", display: "flex", flexDirection: "column", gap: 8 }}>
      {item.intent != null && <IntentChip intent={item.intent} source={item.source} />}

      {item.status === "normalizing" && <Thinking label={t.chat.normalizing} />}
      {item.status === "error" && <ErrorBubble message={item.error ?? t.chat.errorFallback} />}
      {item.status === "ready" && item.request != null && (
        <StreamingAssistant request={item.request} sessionId={props.sessionId} />
      )}
    </div>
  );
});

/**
 * Drives the streaming composition for one message. Receives skeleton → final form via useSpecStream, and
 * after settling, part events (row clicks, etc.) are re-composed via the non-stream /events and shown as an override.
 */
function StreamingAssistant(props: { request: () => Promise<Response>; sessionId: string }): ReactNode {
  const stream = useSpecStream();
  const [override, setOverride] = useState<ComposeView | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  // Generation guard (same useLatestRequest hook DashboardPage.handleEvent uses): if another event ran while
  // awaiting the response, do not roll back the new display with a stale response (even if they resolve in
  // B→A order, the display does not revert to A).
  const { loading: interacting, run } = useLatestRequest();
  const t = useT();

  // Start the stream on mount (request is fixed per message).
  useEffect(() => {
    stream.start(props.request);
    // stream is created on every render, so it is not included in the deps (request alone is unique).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.request]);

  const streamView: ComposeView | null =
    stream.spec != null && stream.capability != null
      ? { spec: stream.spec, capability: stream.capability }
      : null;
  const view = override ?? streamView;
  const settled = override != null || stream.phase === "done";

  const handleEvent = (event: SurfaceEvent): Promise<void> => {
    if (view == null) return Promise.resolve();
    return run(
      () =>
        sendEvent({
          intent: { canonical: view.spec.intent.canonical, params: view.spec.intent.params },
          on: event.on,
          payload: event.payload,
          surface: "chat",
          sessionId: props.sessionId,
        }),
      {
        onStart: () => setEventError(null),
        onResult: setOverride,
        onError: (e) => setEventError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  if (stream.phase === "error" && override == null) {
    return <ErrorBubble message={stream.error?.message ?? t.chat.compositionFailed} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {view != null ? (
        <>
          {settled ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <ProvenanceBadge spec={view.spec} />
              <DashboardLink intent={view.spec.intent} />
            </div>
          ) : (
            <div style={{ color: "var(--app-muted, #6b7280)", fontSize: 12 }}>{t.chat.composingSkeleton}</div>
          )}
          <div
            style={{
              background: "var(--app-elevated, #fff)",
              border: "1px solid var(--app-border, #e5e7eb)",
              borderRadius: 12,
              padding: 18,
            }}
          >
            <SpecSurface
              spec={view.spec}
              capability={view.capability}
              onEvent={(event) => void handleEvent(event)}
            />
          </div>
          {settled && <SpecJsonDrawer spec={view.spec} />}
        </>
      ) : (
        <Thinking label={t.chat.composing} />
      )}
      {interacting && <Thinking label={t.chat.recomposing} />}
      {eventError != null && <ErrorBubble message={eventError} />}
    </div>
  );
}

function IntentChip({ intent, source }: { intent: CanonicalIntent; source?: string }): ReactNode {
  const t = useT();
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        alignSelf: "flex-start",
        background: "#eef2ff",
        color: "#3730a3",
        borderRadius: 8,
        padding: "6px 12px",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontWeight: 700 }}>{intent.canonical}</span>
      <span>{JSON.stringify(intent.params)}</span>
      <span title={t.chat.intentHashTitle}>{intent.hash.replace("sha256:", "#").slice(0, 9)}…</span>
      {source === "llm" && <span style={{ opacity: 0.7 }}>{t.chat.viaLlm}</span>}
    </div>
  );
}

function DashboardLink({ intent }: { intent: CanonicalIntent }): ReactNode {
  const t = useT();
  // sales.custom has no corresponding view on the Dashboard, so we do not show a link (early return before building the URL).
  if (intent.canonical === "sales.custom") return null;
  const params = new URLSearchParams({ intent: intent.canonical });
  for (const [key, value] of Object.entries(intent.params)) {
    if (value != null) params.set(key, String(value));
  }
  return (
    <Link
      to={`/?${params.toString()}`}
      style={{ fontSize: 12, color: "var(--app-primary, #4f46e5)", textDecoration: "none", fontWeight: 600 }}
    >
      {t.chat.openInDashboard}
    </Link>
  );
}

function ErrorBubble({ message }: { message: string }): ReactNode {
  return <ErrorBanner text={message} />;
}

function Thinking({ label }: { label: string }): ReactNode {
  return (
    <div
      style={{
        color: "var(--app-muted, #6b7280)",
        fontSize: 13,
        display: "flex",
        gap: 8,
        alignItems: "center",
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          border: "2px solid #c7d2fe",
          borderTopColor: "var(--app-primary, #4f46e5)",
          borderRadius: "50%",
          display: "inline-block",
          animation: "kohaku-spin 0.8s linear infinite",
        }}
      />
      <style>{`@keyframes kohaku-spin { to { transform: rotate(360deg); } }`}</style>
      {label}
    </div>
  );
}
