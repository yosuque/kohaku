import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import type { SurfaceEvent } from "../src/index.js";
import { defineKohakuSurface, KOHAKU_EVENT, type KohakuSurface, type SurfaceContext } from "../src/index.js";

defineKohakuSurface();

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const INTENT2 = { canonical: "a.b", params: {}, hash: "sha256:" + "1".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

/** Builds a valid UISpec for tests via parseSpec (with defaults/validation). */
export function buildSpec(partial: {
  components: unknown[];
  events?: unknown[];
  state?: Record<string, unknown>;
  dataVersion?: string;
  refVersions?: Record<string, string>;
  intent?: typeof INTENT | typeof INTENT2;
  kohaku?: "0.1" | "0.2";
  /** Merged over the default PROVENANCE (e.g. `{ kit: { id: "kohaku", version: "1" } }`). */
  provenance?: Record<string, unknown>;
}): UISpec {
  return parseSpec({
    kohaku: partial.kohaku ?? (partial.state != null ? "0.2" : "0.1"),
    intent: partial.intent ?? INTENT,
    dataVersion: partial.dataVersion ?? "v1",
    ...(partial.refVersions != null ? { refVersions: partial.refVersions } : {}),
    ...(partial.state != null ? { state: partial.state } : {}),
    components: partial.components,
    events: partial.events ?? [],
    provenance: { ...PROVENANCE, ...partial.provenance },
  });
}

export const INTENT_A = INTENT;
export const INTENT_B = INTENT2;

/** Connects the surface to the document and sets context → spec in order to render in one pass. */
export function mount(spec: UISpec, ctx: SurfaceContext = {}): KohakuSurface {
  const surface = document.createElement("kohaku-surface") as KohakuSurface;
  document.body.appendChild(surface);
  surface.context = ctx;
  surface.spec = spec;
  return surface;
}

/** The shadow root's render root. */
export function root(surface: KohakuSurface): HTMLElement {
  return surface.shadowRoot!.querySelector(".kohaku-root") as HTMLElement;
}

/** Gets the node with data-kohaku="id". */
export function byKohaku(surface: KohakuSurface, id: string): HTMLElement | null {
  return surface.shadowRoot!.querySelector(`[data-kohaku="${id}"]`);
}

/** Collects forward events (kohaku-event) into an array. */
export function collectEvents(surface: KohakuSurface): SurfaceEvent[] {
  const events: SurfaceEvent[] = [];
  surface.addEventListener(KOHAKU_EVENT, (e) => events.push((e as CustomEvent<SurfaceEvent>).detail));
  return events;
}

/** Drains a few turns of microtasks to flush the async data-resolution .then chains. */
export async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
