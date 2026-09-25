import type { KohakuClient } from "@kohaku-ui/client";
import type { ThemeTokens } from "@kohaku-ui/spec-core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  /**
   * The promotion / fixation nomination thresholds (GET /analytics/summary's `promotionPolicy`), fetched once
   * per `(client, tenant)` here rather than by every tab that needs one — `usePromotions` / `useFixations` read
   * these instead of each issuing their own `analytics.summary()` call on every reload. `null` until the fetch
   * resolves, and `null` again if it fails (the empty-state copy falls back to `emptyDefault` in that case).
   */
  promotionMinUses: number | null;
  fixationMinUses: number | null;
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
  /**
   * Scopes the once-per-`(client, tenant)` threshold fetch (see `AdminContextValue.promotionMinUses`). The
   * tenant header itself still rides on `client` (the product's own `headers()` hook) — this is only the
   * dependency that tells this provider a tenant switch happened and the thresholds should be re-fetched.
   */
  tenant?: string;
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

  const { client, tenant } = props;
  const [promotionMinUses, setPromotionMinUses] = useState<number | null>(null);
  const [fixationMinUses, setFixationMinUses] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    setPromotionMinUses(null);
    setFixationMinUses(null);
    void client.analytics
      .summary()
      .then((s) => {
        if (!current) return;
        setPromotionMinUses(s.promotionPolicy?.promotionMinUses ?? null);
        setFixationMinUses(s.promotionPolicy?.fixationMinUses ?? null);
      })
      .catch(() => {
        if (!current) return;
        setPromotionMinUses(null);
        setFixationMinUses(null);
      });
    return () => {
      current = false;
    };
  }, [client, tenant]);

  const value = useMemo<AdminContextValue>(
    () => ({
      client: props.client,
      messages,
      theme: props.theme,
      notify,
      getMessages,
      promotionMinUses,
      fixationMinUses,
    }),
    [props.client, messages, props.theme, notify, getMessages, promotionMinUses, fixationMinUses],
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
