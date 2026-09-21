import type { KohakuClient } from "@kohaku-ui/client";
import type { ThemeTokens } from "@kohaku-ui/spec-core";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { type AdminMessages, defaultAdminMessages } from "./messages.js";
import type { NotifyFn } from "./ui.js";

export interface AdminContextValue {
  client: KohakuClient;
  messages: AdminMessages;
  theme?: ThemeTokens;
  /** Push a notification (green info by default; 403 / failures are "error"). Identity is stable across renders. */
  notify: NotifyFn;
  /** The dictionary at call time (for async callbacks, so a language switch mid-request is honoured). */
  getMessages: () => AdminMessages;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export interface AdminProviderProps {
  /** Typed host client. baseUrl and any tenant / role headers are configured on the client by the product. */
  client: KohakuClient;
  /** Full dictionary (defaults to English). */
  messages?: AdminMessages;
  /** ThemeTokens applied as `--kohaku-*` variables by KohakuAdmin / forwarded to the promotion preview iframe. */
  theme?: ThemeTokens;
  /** Receives every notification the console emits (KohakuAdmin also renders them as a banner). */
  onNotice?: NotifyFn;
  children: ReactNode;
}

export function AdminProvider(props: AdminProviderProps): ReactNode {
  const messages = props.messages ?? defaultAdminMessages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onNoticeRef = useRef(props.onNotice);
  onNoticeRef.current = props.onNotice;
  const notify = useCallback<NotifyFn>((text, kind = "info") => onNoticeRef.current?.(text, kind), []);
  const getMessages = useCallback(() => messagesRef.current, []);
  const value = useMemo<AdminContextValue>(
    () => ({ client: props.client, messages, theme: props.theme, notify, getMessages }),
    [props.client, messages, props.theme, notify, getMessages],
  );
  return <AdminContext.Provider value={value}>{props.children}</AdminContext.Provider>;
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (ctx == null)
    throw new Error("admin-react components must be rendered inside <AdminProvider> or <KohakuAdmin>");
  return ctx;
}

/** The notify function alone (for product toolbars rendered inside KohakuAdmin). */
export function useAdminNotice(): NotifyFn {
  return useAdmin().notify;
}
