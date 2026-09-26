import type { Scope } from "@kohaku-ui/spec-core";
import type { CSSProperties, ReactNode } from "react";
import { V } from "../../theme.js";
import { Empty } from "../../ui.js";
import type { DevToolsMessages } from "../messages.js";

const row: CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 12,
  padding: "3px 0",
  fontFamily: "ui-monospace, monospace",
};

/** The capability scopes collectCapabilityScopes(spec) derives -- present only when a Spec was passed to
 * KohakuDevTools / buildExplainReport. */
export function ScopesPanel(props: { scopes?: Scope[]; messages: DevToolsMessages }): ReactNode {
  const t = props.messages;
  if (props.scopes == null) return <Empty text={t.scopes.noSpec} />;
  if (props.scopes.length === 0) return <Empty text={t.scopes.empty} />;
  return (
    <div>
      {props.scopes.map((s) => (
        <div key={`${s.kind}:${s.ref}`} style={row}>
          <span style={{ color: s.kind === "write" ? V.negativeText : V.infoText, fontWeight: 700 }}>
            {s.kind}
          </span>
          <span>{s.ref}</span>
        </div>
      ))}
    </div>
  );
}
