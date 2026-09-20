import { SandboxFrame } from "@kohaku-ui/sandbox/react";
import {
  type ComponentNode,
  type JsonValue,
  SANDBOX_HTML_TYPE,
  sha256Hex,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/ui.js";
import { useThemeMode } from "../../theme/mode.js";
import { buildTheme } from "../../theme/tokens.js";
import { extractPastedRef } from "./gallery-ref.js";
import { GALLERY_CANNED_REF, GALLERY_SHOWCASE_HTML } from "./gallery-showcase.js";

/** Canned tabular data returned for any ref (deterministic; the gallery never touches the API). */
const CANNED_DATA = {
  columns: [
    { key: "region", label: "Region", type: "string" },
    { key: "sales", label: "Sales", type: "number" },
  ],
  rows: [
    { region: "East", sales: 1_234_000 },
    { region: "West", sales: 987_000 },
    { region: "North", sales: 654_000 },
    { region: "South", sales: 1_120_000 },
    { region: "Central", sales: 432_000 },
  ],
  dataVersion: "gallery",
};

/**
 * Design-kit gallery (dev/admin only): mounts the hand-written showcase artifact and any pasted L2
 * artifact through the real SandboxFrame with the current theme, so the effect of the kit and of a
 * theme switch can be compared side by side (kit on/off). Data is canned, so it works without the API.
 */
export function GalleryTab(): ReactNode {
  const t = useT();
  const { mode } = useThemeMode();
  const theme = useMemo(() => buildTheme(mode), [mode]);
  const [kitOn, setKitOn] = useState(true);
  const [pasted, setPasted] = useState("");
  const [pastedHash, setPastedHash] = useState<string | null>(null);
  const [showcaseHash, setShowcaseHash] = useState<string | null>(null);

  useEffect(() => {
    void sha256Hex(GALLERY_SHOWCASE_HTML).then(setShowcaseHash);
  }, []);
  useEffect(() => {
    if (pasted.trim() === "") {
      setPastedHash(null);
      return;
    }
    void sha256Hex(pasted).then(setPastedHash);
  }, [pasted]);
  // A pasted artifact was generated against its own $ref (unknown to us), not the gallery's canned one —
  // scrape it out of the source so the sandbox bridge's exact-match allowlist admits its fetchData call
  // instead of silently denying every fetch (see gallery-ref.ts's doc). Falls back to the canned ref for
  // an artifact that never fetches (or whose call this heuristic cannot find).
  const pastedRef = useMemo(() => extractPastedRef(pasted, GALLERY_CANNED_REF), [pasted]);

  const kitCss = kitOn ? undefined : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, color: "var(--app-muted, #6b7280)" }}>{t.admin.gallery.description}</div>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={kitOn} onChange={(e) => setKitOn(e.target.checked)} />
        {t.admin.gallery.kitToggle}
      </label>
      <Preview
        id="showcase"
        html={GALLERY_SHOWCASE_HTML}
        sha256={showcaseHash}
        dataRef={GALLERY_CANNED_REF}
        theme={theme}
        kitCss={kitCss}
      />
      <textarea
        aria-label={t.admin.gallery.pasteLabel}
        placeholder={t.admin.gallery.pastePlaceholder}
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        rows={6}
        style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
      />
      {pastedHash != null && (
        <Preview
          id="pasted"
          html={pasted}
          sha256={pastedHash}
          dataRef={pastedRef}
          theme={theme}
          kitCss={kitCss}
        />
      )}
    </div>
  );
}

function Preview(props: {
  id: string;
  html: string;
  sha256: string | null;
  /** The $ref this preview's node declares; must equal the ref the artifact's own fetchData call passes
   * (the sandbox bridge denies a mismatch silently — see gallery-showcase.ts's GALLERY_CANNED_REF doc). */
  dataRef: string;
  theme: ReturnType<typeof buildTheme>;
  kitCss: string | undefined;
}): ReactNode {
  if (props.sha256 == null) return null;
  const node: ComponentNode = {
    id: `gallery-${props.id}`,
    type: SANDBOX_HTML_TYPE,
    props: {},
    artifact: { inline: props.html, sha256: props.sha256 },
    data: { $ref: props.dataRef },
  };
  const spec: UISpec = {
    kohaku: "0.1",
    intent: { canonical: "admin.gallery", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "gallery",
    components: [node],
    events: [],
    provenance: { tier: "L2", composedBy: "admin-gallery", cache: "bypass" },
  };
  return (
    <div style={{ border: "1px dashed var(--app-border, #e5e7eb)", borderRadius: 8, padding: 10 }}>
      <SandboxFrame
        key={`${props.id}-${props.dataRef}-${props.kitCss ?? "default"}`}
        node={node}
        spec={spec}
        theme={props.theme}
        // The showcase is the clean "what the kit looks like" shot; the paste box mounts arbitrary
        // third-party HTML, so its badge stays visible as the one on-screen signal that it is sandboxed.
        badge={props.id === "pasted" ? "visible" : "hidden"}
        {...(props.kitCss != null ? { kitCss: props.kitCss } : {})}
        bridge={{
          resolveBinding: async () => CANNED_DATA as unknown as JsonValue,
          onEvent: () => {},
          // A denied/failed fetch inside the sandbox is otherwise silent (the guest still calls ready() on
          // its own error path) — surface it to the console so a ref/kit mismatch is visible immediately
          // instead of only as an empty widget.
          onTelemetry: (event) => {
            if (event.kind === "error" || event.kind === "denied") {
              console.warn("[kohaku] gallery", props.id, event);
            }
          },
        }}
      />
    </div>
  );
}
