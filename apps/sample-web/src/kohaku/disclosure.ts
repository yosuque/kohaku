/**
 * The AI-generation disclosure mode the demo web app renders with (design.md #66; SPEC-DISC-001). It is
 * read once from the Vite env var `VITE_KOHAKU_DISCLOSURE` (`off` | `attributes` | `label`), so the
 * disclosure label can be switched on for a demo build without touching the code. Default and any
 * unrecognized value: `"off"` -- the DOM stays identical to a renderer that never heard of disclosure.
 */
export type DisclosureMode = "off" | "attributes" | "label";

export function resolveDisclosureMode(raw: string | undefined): DisclosureMode {
  return raw === "attributes" || raw === "label" ? raw : "off";
}

export const DISCLOSURE_MODE: DisclosureMode = resolveDisclosureMode(
  import.meta.env.VITE_KOHAKU_DISCLOSURE as string | undefined,
);
