import { useEffect, useState } from "react";

/**
 * UI language of the demo ("en" default). Selecting "ja" switches the whole app: the page chrome
 * (i18n/ui.ts dictionary), the Spec renderer messages/locale (SpecSurface), the dashboard facet
 * labels (facet-views labels overlay), and — via session.locale on every API call (kohaku/client.ts) —
 * the server-side NL normalization hint and the generation output language (JA L0 fixed specs and
 * Japanese L1/L2 output, cache-separated per language on the server).
 *
 * Module-store shape (same pattern as kohaku/tenant.ts / role.ts) so the non-React API client can
 * read the current language at request time via getLang(). Persists an explicit choice to localStorage.
 */
export type Lang = "en" | "ja";

const STORAGE_KEY = "kohaku-sample.lang";

/** BCP-47 tags for the renderer locale (number/date formatting, sort collation). */
export const LOCALE_TAGS: Record<Lang, string> = { en: "en-US", ja: "ja-JP" };

function readInitial(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === "ja" ? "ja" : "en";
  } catch {
    return "en";
  }
}

let current: Lang = readInitial();
const listeners = new Set<() => void>();

/** The current language at call time (for non-React modules — the API client attaches it per request). */
export function getLang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // If localStorage is unavailable (private mode, etc.), we simply give up persistence. The switch itself still works.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook with the historical shape ({ lang, setLang, toggle }); call sites are unchanged. */
export function useLang(): { lang: Lang; setLang: (next: Lang) => void; toggle: () => void } {
  const [lang, setLocal] = useState<Lang>(current);
  useEffect(() => subscribe(() => setLocal(current)), []);
  return { lang, setLang, toggle: () => setLang(current === "ja" ? "en" : "ja") };
}
