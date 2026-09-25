# @kohaku-ui-docs/site — the documentation site

The site is **generated** from the Markdown that already lives in the repository (`docs/`, `spec/SPEC.md`,
`python/README.md`). Nothing under this directory is documentation content; edit the Markdown instead.

- `pnpm docs:dev` — local preview (runs the mirror step, then `vitepress dev`)
- `pnpm docs:build` — production build into `apps/docs-site/dist`
- `scripts/sync-docs.ts` — mirrors the Markdown into `.generated/` (gitignored) and rewrites relative links
- `snippets/` — the code shown on the adoption-path pages, typechecked by `pnpm typecheck` and asserted
  byte-identical to the Markdown by `test/snippets.test.ts`
- `src/sidebar.ts` — the sidebar; `test/sidebar.test.ts` fails when a page is added to `docs/` without an entry
