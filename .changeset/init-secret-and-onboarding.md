---
"@kohaku-ui/cli": minor
"@kohaku-ui/llm": patch
---

`kohaku init`'s generated project no longer falls back to a fixed `dev-secret-change-me` capability secret:
`server/app.ts` now throws `KOHAKU_CAPABILITY_SECRET is required (see .env.example)` when it is unset, and
`initProject` writes a real, randomly generated secret (`randomBytes(32).toString("base64url")`) to a
git-ignored `.env` so the generated project still runs out of the box; `.env.example` now ships that var
empty (with a comment) instead of a shared placeholder value, and the generated `server/app.ts` loads `.env`
itself so this also works when it's imported directly (the golden test, scripting) rather than only via
`server/main.ts`.

`@kohaku-ui/llm`'s `resolveLlmEnv` now treats an empty-string (or whitespace-only) `KOHAKU_LLM_API_KEY` or
provider-standard key env var as unset instead of a configured empty key — needed because the generated
`.env.example`'s `KOHAKU_LLM_API_KEY=` placeholder previously defeated the fallback to `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` once loaded via `process.loadEnvFile`.

Also: the CLI's own description and `--help` text now mention `init` / project generation; `kohaku init`'s
"Next steps" output and the generated README point at the one-time `KOHAKU_GOLDEN_UPDATE=1 npm test`; the
generated README notes that Chat only answers within the generated Intent catalog (`NO_MATCH` otherwise,
widened via `fallbackIntent`); and the root README / user guide point at
`cli/test/init/fixtures/sales.csv` for anyone without a CSV of their own to try.
