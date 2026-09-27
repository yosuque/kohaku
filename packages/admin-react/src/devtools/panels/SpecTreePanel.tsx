import type { ComponentNode, UISpec } from "@kohaku-ui/spec-core";
import type { CSSProperties, ReactNode } from "react";
import { V } from "../../theme.js";
import { Empty } from "../../ui.js";
import type { DevToolsMessages } from "../messages.js";

const nodeLine: CSSProperties = { fontSize: 12, fontFamily: "ui-monospace, monospace", padding: "2px 0" };

function componentNode(spec: UISpec, id: string, depth: number, seen: Set<string>): ReactNode {
  // A cyclic children graph should never occur (spec-core's validate rejects it), but a devtool must not
  // hang the tab if a hand-edited/malformed Spec ever reaches it -- stop descending into an id already on
  // the current path instead.
  if (seen.has(id)) return null;
  const node = spec.components.find((c) => c.id === id);
  if (node == null) return null;
  const nextSeen = new Set(seen).add(id);
  return (
    <div key={id} style={{ paddingLeft: depth * 16 }}>
      <div style={nodeLine}>
        <span style={{ color: V.muted }}>{id}</span> <strong>{node.type}</strong>
        {node.data?.$ref != null && <span style={{ color: V.infoText }}> {node.data.$ref}</span>}
        {node.visibleWhen != null && <span style={{ color: V.warningText }}> [conditional]</span>}
      </div>
      {(node.children ?? []).map((childId) => componentNode(spec, childId, depth + 1, nextSeen))}
    </div>
  );
}

/** The Spec's component tree (id / type / $ref / conditional-display marker), rooted at every component no
 * other component declares as a child (ordinarily just "root"). */
export function SpecTreePanel(props: { spec?: UISpec; messages: DevToolsMessages }): ReactNode {
  const t = props.messages;
  if (props.spec == null) return <Empty text={t.specTree.empty} />;
  const spec = props.spec;
  const childIds = new Set(spec.components.flatMap((c: ComponentNode) => c.children ?? []));
  const roots = spec.components.filter((c) => !childIds.has(c.id));
  return <div>{roots.map((r) => componentNode(spec, r.id, 0, new Set()))}</div>;
}
