import { type Disclosure, deriveDisclosure, disclosureDomAttributes } from "@kohaku-ui/renderer-core";
import { type ReactNode, useMemo } from "react";
import { useMessages, useSpec } from "./context.js";

/** The current Spec's AI-generation disclosure (design.md #66), derived from its provenance. Must be
 * used inside `<SpecView>` (it reads the same Spec context `useSpec` does). */
export function useDisclosure(): Disclosure {
  const spec = useSpec();
  return useMemo(() => deriveDisclosure(spec.provenance), [spec.provenance]);
}

/**
 * A small, self-contained disclosure label: the localized text (`RendererMessages.disclosureAiGenerated`
 * / `disclosureAiReviewed`) plus its own `data-kohaku-disclosure` / `data-kohaku-tier` /
 * `data-digital-source-type` attributes, so it renders correctly wherever it is placed -- inside
 * `<SpecView disclosure="label">` (which mounts it automatically) or standalone in a host's own layout.
 * Renders nothing when the current disclosure level is `"none"` (nothing to disclose).
 */
export function KohakuDisclosureLabel(): ReactNode {
  const disclosure = useDisclosure();
  const messages = useMessages();
  if (disclosure.level === "none") return null;
  const text =
    disclosure.level === "ai-generated" ? messages.disclosureAiGenerated : messages.disclosureAiReviewed;
  return <span {...disclosureDomAttributes(disclosure)}>{text}</span>;
}
