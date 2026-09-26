import type { ReactNode } from "react";

export interface PlaygroundBarProps {
  onReset: () => void | Promise<void>;
}

/**
 * The playground-only banner (permanently above sample-web's own header, via `App`): states plainly that
 * this is a replay, not a live product, gives a Reset button (see `host/reset.ts`), and links out to the
 * real project. Example-scenario buttons are deliberately not here yet — u5-3 picks the recorded scenarios
 * first, then this bar gets a row of them; until then this is just the frame the brief asked for.
 *
 * Not localized (unlike the rest of sample-web, which has full EN/JA via `i18n/ui.ts`): this component lives
 * in apps/playground, not sample-web, and is deliberately kept out of that package's i18n system rather than
 * forking it in.
 */
export function PlaygroundBar({ onReset }: PlaygroundBarProps): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "6px 20px",
        fontSize: 12.5,
        background: "var(--app-primary-weak, #eef2ff)",
        borderBottom: "1px solid var(--app-border, #e5e7eb)",
        color: "var(--app-text, #1a1a2e)",
      }}
    >
      <span>
        <strong>Playground</strong> — replaying recorded LLM responses. Nothing you do here calls a real
        model, and nothing leaves your browser.
      </span>
      <button
        type="button"
        onClick={onReset}
        style={{
          border: "1px solid var(--app-border, #e5e7eb)",
          borderRadius: 6,
          padding: "3px 10px",
          fontSize: 12,
          background: "var(--app-elevated, #fff)",
          color: "var(--app-text, #1a1a2e)",
          cursor: "pointer",
        }}
      >
        Reset
      </button>
      {/* Example-scenario buttons land here once u5-3 has picked the recorded scenarios. */}
      <nav style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
        <a href="https://github.com/yosuque/kohaku" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a href="https://www.npmjs.com/org/kohaku-ui" target="_blank" rel="noreferrer">
          npm
        </a>
        {/* No public docs-site URL exists yet (apps/docs-site's `base` is env-driven, unpublished — see
            reports/u5-2.md) — links to the docs source in the repo itself in the meantime. */}
        <a href="https://github.com/yosuque/kohaku/tree/main/docs" target="_blank" rel="noreferrer">
          Docs
        </a>
      </nav>
    </div>
  );
}
