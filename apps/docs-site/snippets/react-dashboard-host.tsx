import { createKohakuClient } from "@kohaku-ui/client";
import { createBindingClient } from "@kohaku-ui/data-binding";
import { defaultLightTheme } from "@kohaku-ui/renderer-core";
import { RendererProvider, SpecView } from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import type { UISpec } from "@kohaku-ui/spec-core";
import { useEffect, useState } from "react";

const BASE_URL = "http://localhost:8787/api/kohaku"; // any kohaku REST host (pnpm dev, or your own)
const client = createKohakuClient({ baseUrl: BASE_URL });
const impls = createCoreRegistry();
const intent = { canonical: "sales.quarterly_summary", params: { fiscalYear: 2026, quarter: 3 } };

export function Dashboard() {
  const [view, setView] = useState<{ spec: UISpec; capability: string } | null>(null);
  // A GUI request: the host normalizes it to a canonical Intent and answers with the (cached) Spec.
  useEffect(() => void client.compose({ intent }).then(setView), []);
  if (view == null) return <p>Loading…</p>;
  // Components fetch their own data by reference, with the capability the host issued for this Spec.
  const binding = createBindingClient({ baseUrl: BASE_URL, capability: view.capability });
  return (
    <RendererProvider value={{ impls, binding, theme: defaultLightTheme }}>
      <SpecView spec={view.spec} />
    </RendererProvider>
  );
}
