---
"@kohaku-ui/composer": patch
"@kohaku-ui/evals": patch
"@kohaku-ui/lineage": patch
"@kohaku-ui/host-core": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host-mcp-apps": patch
"@kohaku-ui/renderer-core": patch
"@kohaku-ui/renderer-react": patch
"@kohaku-ui/renderer-wc": patch
"@kohaku-ui/cli": patch
---

Behavior-preserving structural refactoring round (third pass). No wire shape, message, status code, prompt byte, cache key, lineage payload or generated-project byte changes; every step is pinned by existing tests plus new characterization tests.

- `host-core`: new `resolveGuiDelta` (the GUI-delta intent resolution both hosts ran inline) and `runActionGate` (the governed-action gate sequence — operation index → declared entry → schema → unsafe keys → `ActionGate.check` → audit — that REST `/binding/action` and MCP `kohaku_action` maintained twice; each host keeps only its wire mapping and `onError` endpoint names). Both hosts' gate sequences are pinned by new `action-gate-sequence` characterization tests.
- `host-mcp-apps`: `composeAndPackage` is now sequential steps (`composeForDelivery` → `packageComposed`) instead of a callback that smuggled the capability and manifest out; a local `authorizeCapability` for the app-only tools.
- `host-rest`: a local `authorizeCapability` in the binding routes.
- `renderer-core`: new `describeSpreadsheetFooter` descriptor (with `SpreadsheetFooterDescriptor`), the single source of the spreadsheet footer decision now shared by `renderer-react` and `renderer-wc`.
- `composer`: the policy-fingerprint machinery moved to its own module (`policy-fingerprint.ts`, same exported names); the L0 fixed-Spec short-circuit now runs through the same assemble → store → trace tail as L1/L2 (pinned by an L0/L1 characterization test); smaller extractions in `tier-ladder.ts` and `tiers/l2-generate.ts`; a contract test that the design-kit namespaces match the utility prefixes.
- `evals`: `createJudge`'s prompt builders are all module-level now (`buildL1JudgePrompt`, `rubricSystem`).
- `lineage`: `reconcile` lives in `promotion/reconcile.ts` (`createReconciler`) with the projection argument builders in `promotion/projection.ts`; `approve()`'s judge stage is no longer duplicated; the repeated anonymous promotion types are named (`CreatePromotionsOptions` is now exported); `toProposals` / `durationStats` / `usageRowKey` extracted.
- `cli`: `commands.ts` split into one runner module per command (`conformance`, `explain`, `smoke-l2`, `component`, `dataset`, `scaffold`) so each action loads only its own runner; the `--mcp` addon of `kohaku init` lives in `init/mcp-addon.ts`; `EXTERNAL_VERSIONS` is typed by key; the generated project is pinned byte for byte by goldens under `cli/test/init/__golden__` (regenerate with `KOHAKU_UPDATE_INIT_GOLDEN=1`).
