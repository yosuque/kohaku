---
"@kohaku-ui/cli": patch
---

Stop declaring `tsx` as a runtime dependency of the published CLI. The published `kohaku` bin runs the compiled `dist/index.js`, so `npx @kohaku-ui/cli` no longer downloads tsx/esbuild; the in-repo `bin/kohaku.js` launcher still resolves tsx from the workspace.
