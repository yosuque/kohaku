---
"@kohaku-ui/cli": patch
---

`kohaku --help` and `kohaku init --help` no longer load the command implementations. Each subcommand now imports its own module (`commands`, `evidence`, `migrate`, `init`) when it runs, so a partial install (a missing optional workspace package) still prints help instead of failing with `ERR_MODULE_NOT_FOUND`. `writeScaffold` and `parseHeaderArgs` moved to a dependency-free `scaffold-fs` module (still re-exported from `commands`). Measured on the source launcher (tsx), `--help` went from a median of 539 ms to 381 ms over 5 runs; the built `dist/index.js` prints help in a median of 114 ms.
