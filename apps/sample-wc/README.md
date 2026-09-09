# @kohaku-ui-sample/wc — non-React renderer demo (Vanilla + Web Components)

English | [日本語](README.ja.md)

A Vanilla page that renders sample-api's compose results with **zero React** via `<kohaku-surface>`
(`@kohaku-ui/renderer-wc`). It proves the core claim — "the declarative UI Spec is renderer-independent" —
by drawing the same Spec as the React version (sample-web) with a different renderer.

## Running

Start the two processes in separate terminals (from the repo root):

```bash
# 1) the host (sample-api, :8787)
pnpm --filter @kohaku-ui-sample/api dev

# 2) this demo page (:5174; /api is proxied to :8787)
pnpm --filter @kohaku-ui-sample/wc dev
```

Open <http://localhost:5174> in a browser. It is not part of the root `pnpm dev` (sample-api + sample-web)
and starts independently. No LLM is required — quarterly_summary returns via the deterministic fixed-Spec path.

The page chrome and the Spec render messages are English by default. Append `?lang=ja`
(<http://localhost:5174/?lang=ja>) to render the Spec messages in Japanese via the RendererMessages i18n
override (an i18n demo; the page chrome stays English).

## Highlights

- **A1 two-way binding (cross-filter)**: changing the region select re-resolves the effective ref of
  `control.select` → `state.set` → `data.bind` on the client side (no compose is fired). The capability is
  issued at the initial compose so that `/binding/resolve` passes for every region variant.
- **Server recomposition**: a table row click (`intent.patch`) flows to `/events` and the view re-renders
  with the new Spec.
- **Governance (SPEC-EVT-002)**: only events declared in the Spec's `events` reach `onEvent` /
  `CustomEvent("kohaku-event")`. `state.set` completes inside the Renderer and never goes upstream.

## Implementation notes

- Dependencies are only `@kohaku-ui/client` (the typed REST client), `@kohaku-ui/renderer-wc`, and
  `@kohaku-ui/spec-core`. No React and no build plugins.
- Theme tokens are the same values as sample-web (`src/theme.ts`). Both renderers inline-expand the same
  values, so everything except charts looks identical (charts stay semantically equivalent — Recharts vs
  inline SVG).
