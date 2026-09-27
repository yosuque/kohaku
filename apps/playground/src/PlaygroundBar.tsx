import type { ReactNode } from "react";
import type { Scenario } from "./scenarios.js";

export interface PlaygroundBarProps {
  onReset: () => void | Promise<void>;
  /** The full scenario list (`scenarios.ts`), in display order. */
  scenarios: readonly Scenario[];
  /** `Scenario.id`s with a recorded fixture — see `host/fixtures.ts`'s `RECORDED_SCENARIO_IDS`. A scenario
   * not in this set renders disabled, labeled "awaiting recording", regardless of `requiresFixtures`
   * (irrelevant for the 4 L0 scenarios, which are always recorded — vacuously true, since they need none). */
  recordedScenarioIds: ReadonlySet<string>;
  /** Runs an enabled scenario (see `main.tsx`'s `runScenario` — navigates the dashboard to the scenario's
   * Intent/params, or Chat for an NL-shaped one). Never called for a disabled (unrecorded) scenario. */
  onRunScenario: (scenario: Scenario) => void;
  /**
   * A one-line notice from `host/fetch-shim.ts`'s `onGenerationFallback` — composer degraded a request to
   * its deterministic fallback (an unrecorded `ReplayLlm` key, most likely from a free-form Chat question
   * no scenario covers). `null` when there is nothing to show. Shown in place of the bar's own default
   * copy until dismissed.
   */
  notice: string | null;
  onDismissNotice: () => void;
}

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--app-border, #e5e7eb)",
  borderRadius: 6,
  padding: "3px 10px",
  fontSize: 12,
  background: "var(--app-elevated, #fff)",
  color: "var(--app-text, #1a1a2e)",
  cursor: "pointer",
};

/**
 * The playground-only banner (permanently above sample-web's own header, via `App`): states plainly that
 * this is a replay, not a live product, gives a Reset button (see `host/reset.ts`), a row of example
 * scenarios (`scenarios.ts` — disabled with "awaiting recording" until `record-fixtures.ts` is actually run;
 * see reports/u5-3.md), and links out to the real project.
 *
 * Not localized (unlike the rest of sample-web, which has full EN/JA via `i18n/ui.ts`): this component lives
 * in apps/playground, not sample-web, and is deliberately kept out of that package's i18n system rather than
 * forking it in.
 */
export function PlaygroundBar({
  onReset,
  scenarios,
  recordedScenarioIds,
  onRunScenario,
  notice,
  onDismissNotice,
}: PlaygroundBarProps): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "6px 20px",
        fontSize: 12.5,
        background: "var(--app-primary-weak, #eef2ff)",
        borderBottom: "1px solid var(--app-border, #e5e7eb)",
        color: "var(--app-text, #1a1a2e)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {notice != null ? (
          <span style={{ color: "#92400e" }}>
            <strong>Note:</strong> {notice}
          </span>
        ) : (
          <span>
            <strong>Playground</strong> — replaying recorded LLM responses. Nothing you do here calls a real
            model, and nothing leaves your browser.
          </span>
        )}
        {notice != null && (
          <button type="button" onClick={onDismissNotice} style={buttonStyle}>
            Dismiss
          </button>
        )}
        <button type="button" onClick={onReset} style={buttonStyle}>
          Reset
        </button>
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {scenarios.map((scenario) => {
          const recorded = recordedScenarioIds.has(scenario.id);
          const enabled = recorded || !scenario.requiresFixtures;
          return (
            <button
              key={scenario.id}
              type="button"
              disabled={!enabled}
              title={enabled ? scenario.label : `${scenario.label} — awaiting recording`}
              onClick={() => onRunScenario(scenario)}
              style={{
                ...buttonStyle,
                opacity: enabled ? 1 : 0.5,
                cursor: enabled ? "pointer" : "not-allowed",
              }}
            >
              [{scenario.kind}] {scenario.label}
              {!enabled && " (awaiting recording)"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
