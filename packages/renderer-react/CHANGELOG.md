# @kohaku-ui/renderer-react

## 0.5.0

### Patch Changes

- Updated dependencies [[`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d)]:
  - @kohaku-ui/spec-core@0.5.0
  - @kohaku-ui/data-binding@0.5.0
  - @kohaku-ui/registry@0.5.0
  - @kohaku-ui/renderer-core@0.5.0

## 0.4.1

### Patch Changes

- [#75](https://github.com/yosuque/kohaku/pull/75) [`171103f`](https://github.com/yosuque/kohaku/commit/171103f58ab87ff98daad8cb12901d417079d76b) Thanks [@yosuque](https://github.com/yosuque)! - **Breaking for custom full dictionaries:** a product that supplies its own complete `RendererMessages` (instead of spreading `DEFAULT_MESSAGES`) must add the two new required keys `actionApprovalPrompt` and `actionAwaitingApprovalDetail`, and one that supplies a complete `AdminMessages` must add `tabApprovals` and the `approvals` block (see `defaultAdminMessages`); partial overrides on top of the defaults are unaffected.
  
  Approvals get an approver-facing inbox and a default requester-side step, with no wire, SPEC or lineage-event change (design.md decision 72). `@kohaku-ui/admin-react` adds an **Approvals** tab (`ApprovalsTab`, `useApprovalInbox`, the `PendingApproval` type; the lineage-derivation function itself is deliberately not exported, since the settle rule belongs with lineage and is not yet released): it derives the pending `"approve"`-tier requests from the lineage tail (the last 24 hours, at most 1000 `action.approvalRequested` / `action.approved` events, with a notice when the cap is reached; `action.invoked` is deliberately not read) and mints a copyable bearer token with `POST /approvals`. Approve is disabled for a row whose recorded payload does not match its hash and while an issued token is still valid; a payload that cannot be re-hashed marks only that row `payloadHashState: "unverifiable"`. `KohakuAdmin` gains `hiddenTabs?: AdminTabKey[]` so a host that wires no `ApprovalPort` can hide the tab. `AdminMessages` gains `tabApprovals` and an `approvals` block (a custom dictionary must add them). `@kohaku-ui/renderer-react` now defaults `requestApproval` to a `globalThis.prompt` for the token, asked only once the node is already awaiting approval and only on a surface that carries an Action manifest (a cancelled or unavailable prompt sends the request tokenless as before; `renderer-wc` has no such default). `@kohaku-ui/renderer-core` adds `RendererMessages.actionApprovalPrompt` / `actionAwaitingApprovalDetail` (a custom full `RendererMessages` object must add them) and the awaiting-approval notice now names the request id and the first 12 hex digits of the payload hash (the renderer shortens it, so `actionAwaitingApprovalDetail(requestId, shortHash)` receives the short form). It also exports `shouldPromptForApproval(phase)` (the rule behind the default prompt, now shared) and `shortPayloadHash(hash)` (also used by the Approvals tab). The Approvals tab sends `ttlSeconds` explicitly so its countdown matches the issued token.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`b1a7af7`](https://github.com/yosuque/kohaku/commit/b1a7af7f39f09f2f088298098eaae618b32e363e) Thanks [@yosuque](https://github.com/yosuque)! - `implement` and `implementWc` parse a node's props against the part's schema once per `node.props` object instead of on every render or rebuild, and emit the dev-mode schema-mismatch warning once per props object (design.md decision 68). Rendered output is unchanged.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`0a2a43b`](https://github.com/yosuque/kohaku/commit/0a2a43b5ea0cbe90df1bbe53af9137452654e477) Thanks [@yosuque](https://github.com/yosuque)! - `action.button` and `presentForm` now show the governed-action phases that stop an action before it commits: a rejected payload (`invalid`, `role="alert"`) and a declined confirmation or pending approval (`awaitingApproval`, `role="status"`). renderer-core adds `actionPhaseNotice` and the `RendererMessages.actionInvalid` / `actionAwaiting` strings (design.md decisions 62-64); `<kohaku-surface>` also clears a form's previous submit message when a new submit starts, as the React form does.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`4072ca8`](https://github.com/yosuque/kohaku/commit/4072ca8c86f28c2bb79abbfc0483b2e6242b7768) Thanks [@yosuque](https://github.com/yosuque)! - Editable `presentSpreadsheet` cells now run the governed-action pre-check in both renderers (a value the `actionManifest` rejects stays in edit mode with `aria-invalid`), and an optimistic cell edit is discarded again when its `cellEdit` invoke ends `invalid`, `awaitingApproval` or `failed`, so the grid shows the server value. renderer-core adds `revertCellEdit`; renderer-react's `useInvokeAction().invoke` takes an optional `onPhase` callback (design.md decisions 62-64).
- Updated dependencies [[`a80f17a`](https://github.com/yosuque/kohaku/commit/a80f17a8ac304def877d23df9e7b8e37ef5c7396), [`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`171103f`](https://github.com/yosuque/kohaku/commit/171103f58ab87ff98daad8cb12901d417079d76b), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`003e360`](https://github.com/yosuque/kohaku/commit/003e3605159973f6837fccf87f83691b40839483), [`5bb982e`](https://github.com/yosuque/kohaku/commit/5bb982e2fca7d4c609d5b99b6dc71bac95dbfe55), [`f34568b`](https://github.com/yosuque/kohaku/commit/f34568bb40e3c136bfc74e9c7d10c50c812f7e18), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`343ccd7`](https://github.com/yosuque/kohaku/commit/343ccd7a71d4370473640dce94f1e2e2a821b39d), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`0a2a43b`](https://github.com/yosuque/kohaku/commit/0a2a43b5ea0cbe90df1bbe53af9137452654e477), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc), [`4072ca8`](https://github.com/yosuque/kohaku/commit/4072ca8c86f28c2bb79abbfc0483b2e6242b7768)]:
  - @kohaku-ui/registry@0.4.1
  - @kohaku-ui/spec-core@0.4.1
  - @kohaku-ui/data-binding@0.4.1
  - @kohaku-ui/renderer-core@0.4.1

## 0.4.0

### Minor Changes

- [#60](https://github.com/yosuque/kohaku/pull/60) [`5f1bbbd`](https://github.com/yosuque/kohaku/commit/5f1bbbd09fe1edb984a7b0f5a0c5212c3da628ea) Thanks [@yosuque](https://github.com/yosuque)! - Adds a Compliance Evidence Pack export (`@kohaku-ui/lineage`'s new `evidence` module; `kohaku evidence
  keygen`/`export`/`verify`) and opt-in AI-generation disclosure for both renderers (design.md [#66](https://github.com/yosuque/kohaku/issues/66)/[#67](https://github.com/yosuque/kohaku/issues/67)).
  
  **Evidence Pack** (`@kohaku-ui/lineage`): `buildEvidencePack` assembles a normalized, Ed25519-signed
  export of the lineage log (`events.jsonl`), a governance-decision index (`approvals.jsonl`:
  `component.reviewed`/`published`/`withdrawn`, `intent.fixated`/`unfixated`), promotion/fixation
  snapshots, and the referenced component HTML artifacts, plus `manifest.json` and a detached signature
  (`manifest.sig`). `EvidenceManifestSchema` is new but deliberately not part of `spec/schemas` — it
  describes an export format for auditors, not a wire type. Ed25519 signing uses `globalThis.crypto.subtle`
  (no new runtime dependency for TS); an artifact whose recorded hash does not match its own content is
  still exported, recorded as a non-fatal warning rather than aborting the export.
  
  **CLI** (`@kohaku-ui/cli`): `kohaku evidence keygen --out-dir <dir>` generates an Ed25519 keypair (private
  key file mode 0600). `kohaku evidence export (--data-dir <dir> | --rest <baseUrl> [--header k:v])
  [--tenant <id>] --since --until --private-key <pem> --out <dir> [--allow-incomplete]` builds and signs a
  pack from a local `StoragePort` data directory or, over REST, from the existing `KohakuClient` surface
  (`lineagePages`/`promotions.list`/`fixations.list`) — the REST source leaves `fixations.jsonl` empty with
  a recorded warning, since `GET /fixations` does not expose enough fields to reconstruct a full
  `FixationRecord`. `kohaku evidence verify <dir> --public-key <pem>` checks the manifest schema, the
  signature, and every file's hash/size, and reports an independent artifact-hash cross-check as non-fatal
  `mismatches`; exit code 0 valid / 1 invalid / 2 usage error. `@kohaku-ui/lineage` and
  `@kohaku-ui/storage-memory` move from `cli`'s devDependencies to dependencies.
  
  **AI-generation disclosure** (`@kohaku-ui/renderer-core`, `@kohaku-ui/renderer-react`,
  `@kohaku-ui/renderer-wc`): `deriveDisclosure(provenance)` (renderer-core) derives a disclosure level
  (`"ai-generated"` for tier L1/L2, `"ai-assisted-reviewed"` for a fixated tier-L0 Spec, `"none"` otherwise
  — never encoded on the wire) and the corresponding `data-kohaku-disclosure`/`data-kohaku-tier`/
  `data-digital-source-type` (IPTC Digital Source Type) attributes. `SpecView` gains a `disclosure?: "off" |
  "attributes" | "label"` prop (renderer-react; also exports `useDisclosure`/`KohakuDisclosureLabel`), and
  `<kohaku-surface>` gains a matching `disclosure` attribute (renderer-wc, applied to the host element,
  with the visible label — `"label"` mode only — inside the shadow root). Both default to `"off"`: existing
  DOM output is unchanged unless a host opts in.
  
  See [docs/user-guide.md](../docs/user-guide.md)'s "Compliance Evidence Pack and AI-generation disclosure"
  section for usage, EU AI Act Article 50 context (not legal advice), and a PII caution for exported Intent
  `params`/request text.

- [#62](https://github.com/yosuque/kohaku/pull/62) [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47) Thanks [@yosuque](https://github.com/yosuque)! - Add Governed Actions: Human-In-The-Loop tiers for `DomainPort` write operations (design.md [#62](https://github.com/yosuque/kohaku/issues/62)/[#63](https://github.com/yosuque/kohaku/issues/63)/[#64](https://github.com/yosuque/kohaku/issues/64);
  SPEC §5's ACT-PRM-001/ACT-APR-001/ACT-CNF-001, LIN-ACT-001, §6.2's MCPAPP-ACT-001).
  
  An operation may declare `tier` (`"auto"` (default) / `"confirm"` / `"approve"`) and `paramsSchema`
  (kohaku's own closed JSON Schema subset — `type`, `properties`, `required`,
  `additionalProperties: false`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `items`, `maxItems`,
  `x-message`; deliberately no `pattern`, to avoid both ReDoS and a JS/Python regex-dialect mismatch).
  `spec-core`'s `validateActionParams`/`assertValidActionParamsSchema` (env-neutral, dependency-free, pinned
  byte-for-byte against the Python port via the cross-language golden) enforces the schema before
  `DomainPort.invoke` ever runs, on every write surface alike: REST's `POST /binding/action`, MCP's
  `${prefix}_action`, and the client-side `preflightAction` check `renderer-core` runs before either.
  
  `"approve"`-tier actions are gated by a new stateless, short-lived HMAC-signed `ApprovalPort`
  (`@kohaku-ui/authz-hmac`'s `createHmacApprovalPort`, `"kohaku-approval.v1."`-prefixed tokens, 300s default
  TTL) bound to `(action, payloadHash, requesterId, tenant)`; self-approval is refused at issuance, and a
  verification failure the host cannot classify is treated as a denial (fail-closed). An optional
  `ApprovalStore` adds single-use enforcement. REST gains `POST /approvals` (mints a token as an authorized
  approver, governance kind `action.approve`) and both the REST body and the MCP action tool's input gain
  optional `confirmed`/`approval` fields; a gate failure is `422 ACTION_PARAMS_INVALID` / `403
  APPROVAL_REQUIRED` on REST (with `error.issues`/`error.approval`) and the MCP structured-tool-error
  equivalent.
  
  A compose response optionally carries an **Action manifest** (REST's `actions?` on
  `/compose`/`/events`/`event: spec`; MCP's `_meta["kohaku/actions"]`) mapping each governed action name to
  `{tier, paramsSchema?, confirmMessage?}` — placed outside the `UISpec` itself, next to the capability, so
  it never affects `specHash` or the cache key. `renderer-core`'s `preflightAction` consults it client-side
  before a write round-trip; `renderer-react`/`renderer-wc`/`mcp-renderer` thread `confirm`/`requestApproval`
  hooks through (`renderer-react` ships a `globalThis.confirm`-backed default for the `"confirm"` tier; there
  is no framework-neutral default for `"approve"`, so that tier stays gated until a product wires its own
  hook). `@kohaku-ui/client`/`@kohaku-ui/data-binding` gain typed `ACTION_PARAMS_INVALID`/`APPROVAL_REQUIRED`
  error codes and `confirmed`/`approval` request options. A host that records action outcomes to lineage does
  so under a distinct `action.*` event family (`action.invoked`/`action.denied`/`action.approvalRequested`/
  `action.approved`), carrying `payloadHash` but never the payload's own field values.
  
  The Python port (`python/kohaku`) mirrors the full surface (`kohaku.spec.action_params`,
  `kohaku.host_core.action_gate`/`action_audit`, `POST /approvals`, the MCP action-tool gate), and
  `apps/sample-api` / `python/examples/sales-api` demonstrate both tiers end to end (`annotate`: confirm,
  `publish`: approve) — see the [user guide](../docs/user-guide.md)'s "Governed actions: tiers" section.
  
  **Behavior changes to check when upgrading.** (1) `POST /binding/action` and the MCP action tool now
  reject, before `DomainPort.invoke` runs, any action that is not in the DomainPort's own
  `listOperations()` — previously such an action was invoked ungated. It is rejected with the same response
  as a missing write scope and recorded as `action.denied`. A product whose `listOperations()` omits an
  operation it still expects to be invoked must declare it. (2) `validateActionParams` rejects a payload
  property named `__proto__`, `constructor` or `prototype` at any depth (issue code `unsafeKey`), whatever
  the schema's `additionalProperties` says.

- [#54](https://github.com/yosuque/kohaku/pull/54) [`bd2d484`](https://github.com/yosuque/kohaku/commit/bd2d484826bec86c78dcb720502740494a672ea8) Thanks [@yosuque](https://github.com/yosuque)! - Adds a typed way to register a product-specific part, so its `{type, version, propsSchema}` can live in one
  `ComponentDefinition` instead of being re-typed as string literals at the registration call site (design.md
  [#68](https://github.com/yosuque/kohaku/issues/68)).
  
  `@kohaku-ui/renderer-react`: `implement(def, Component)` wraps a component whose props are inferred from
  `def.propsSchema` (`z.infer`) — no `node.props["x"] as T` cast needed — and returns an entry consumed by the
  new `ImplRegistry.use(entry)`. The existing `register(type, version, component)` / `ImplProps` keep working
  unchanged for parts that have no static `ComponentDefinition` (e.g. a promoted part's per-artifact schema).
  
  `@kohaku-ui/renderer-wc`: `<kohaku-surface>` gains a public `registerPart(type, version, builder)` (it was
  previously private with no way for a host to register anything beyond the core catalog), plus `getPartVersion`
  for introspection, and `implementWc(def, builder)` is the typed counterpart of `implement` for a `PartBuilder`.
  
  Both `implement` and `implementWc` parse a node's props against the schema **unconditionally, in every
  environment** (`propsSchema.safeParse` is also what materializes a `.default()`-ed prop the Spec omits, not
  just a validation nicety, so it never skips in production) — on success the component receives the parsed
  value, on failure it receives the raw (unvalidated) props instead (fail-open: a malformed prop degrades the
  part's own display rather than the whole surface). Only the diagnostic — a `console.warn` on a mismatch — is
  gated by environment: by default it fires outside a `NODE_ENV=production` build; pass `{ validate }` to force
  the warning on or off regardless of environment.

### Patch Changes

- Updated dependencies [[`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f), [`5f1bbbd`](https://github.com/yosuque/kohaku/commit/5f1bbbd09fe1edb984a7b0f5a0c5212c3da628ea), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/registry@0.4.0
  - @kohaku-ui/renderer-core@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/data-binding@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/data-binding@0.3.0
  - @kohaku-ui/registry@0.3.0
  - @kohaku-ui/renderer-core@0.3.0

## 0.2.0

### Minor Changes

- [#23](https://github.com/yosuque/kohaku/pull/23) [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39) Thanks [@yosuque](https://github.com/yosuque)! - Built-in parts read the non-color tokens (radius / space / font sizes / shadows) instead of literal px, the KPI renders as a card, tables get a muted header with 1px dividers, and hover / active / focus-visible states come from a theme-neutral stylesheet injected once per document (React) / shadow root (WC) — `PARTS_STATE_CSS` is injected unconditionally in this release, with no opt-out. The L2 sandbox chrome is tokenized and `badge="hidden"` removes the badge. Dialogs and toasts render with a stronger elevation, since `shadow.md`'s default was raised. Pre-existing presenter style functions gained an optional trailing `sizing` argument (default = the light theme's sizing); the new helpers (`metric*Style`, `dataStateNoticeStyle`, `gapFor`, `text-style.ts`, `misc-style.ts`) take `sizing` as a required parameter. New exports: `useSizing` (renderer-react) and `DEFAULT_SIZING` (renderer-core). `FORM_ROOT_STYLE` / `FIELD_ROW_STYLE` / `GAP` are deprecated in favour of `formRootStyle` / `fieldRowStyle` / `gapFor`.

- [#23](https://github.com/yosuque/kohaku/pull/23) [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353) Thanks [@yosuque](https://github.com/yosuque)! - Follow-up to the non-color tokens work (`.changeset/l1-parts-tokens.md`): this release settles the two
  places that PR left inconsistent, breaking rather than shimming (0.x, per the deletion-side convention
  this branch has already applied elsewhere).
  
  `@kohaku-ui/renderer-core`:
  
  - Removed the `@deprecated` `FORM_ROOT_STYLE` / `FIELD_ROW_STYLE` (`presenters/form.ts`) and `GAP`
    (`presenters/layout.ts`) constants (no in-repo callers). Use `formRootStyle(sizing)` /
    `fieldRowStyle(sizing)` / `gapFor(sizing, size)` instead — all three already existed alongside them.
  - `sizing: SizingTokens` is now a **required** trailing parameter on the 15 presenter style functions
    that previously defaulted it to the light theme (`formRootStyle`, `fieldRowStyle`,
    `formControlBaseStyle`, `formSubmitButtonStyle`, `actionButtonStyle`, `tabButtonStyle`,
    `dialogTitleStyle`, `toastStyle`, `spreadsheetThStyle`, `spreadsheetSortButtonStyle`,
    `spreadsheetTdStyle`, `spreadsheetCellEditInputStyle`, `spreadsheetFooterBarStyle`,
    `spreadsheetFooterTotalStyle`, `spreadsheetPagerButtonStyle`), matching every other presenter style
    function, which already required it. `DEFAULT_SIZING` stays exported for external callers: pass it
    explicitly to reproduce the exact values a call with no `sizing` argument used to resolve.
  - The L2 sandbox badge/notice chrome (`presenters/sandbox-chrome.ts`) and the overlay dialog
    (`presenters/overlay.ts`) no longer re-resolve non-color tokens from `theme` on every call.
    `sandboxBadgeRowStyle` / `sandboxBadgePillStyle` gain a required trailing `sizing: SizingTokens`
    parameter; `sandboxNoticeBaseStyle`'s signature changes from `(theme)` to `(sizing)` (it never read a
    color token, so `theme` is dropped rather than kept unused); `dialogBoxStyle` gains a required trailing
    `sizing` parameter (after `accentBorder`); `dialogCloseButtonStyle` / `dialogDescriptionStyle` gain a
    required trailing `sizing` parameter. `sandboxBadgeDescriptionStyle` and `sandboxNoticeToneStyle` are
    colors-only and are unchanged. Both renderers' own call sites (`@kohaku-ui/sandbox`'s `SandboxFrame`,
    renderer-wc's `sandbox-mount.ts` / `parts/overlay.ts`, renderer-react's `core/overlay.tsx`) already pass
    their once-per-render resolved `sizing` (`useSizing()` / `RenderRuntime.sizing`), so this is a pure
    signature change for them — no behavior change, no new resolution cost.
  - `SizingTokens` is renamed to `NonColorTokens` (6 of its 22 fields — `fontSans`/`fontMono`,
    `shadowSm`/`shadowMd`, `motionDuration`/`motionEasing` — were never sizes, and the docs and this file's
    own comments already called the group "non-color tokens"). `SizingTokens` remains exported as a type
    alias (`export type SizingTokens = NonColorTokens`), so existing type annotations keep compiling
    unchanged. `resolveSizing` / `useSizing` / `RenderRuntime.sizing` keep their names (unifying that
    naming is a separate follow-up).
  
  - `dialogOverlayStyle` / `dialogHeaderStyle` / `toastDismissButtonStyle` (`presenters/overlay.ts`) were the
    last plain `const` style objects in `overlay.ts` and are now functions, matching every other style export
    in the file: `dialogOverlayStyle(theme, sizing)`, `dialogHeaderStyle(sizing)`,
    `toastDismissButtonStyle(sizing)`. This also finishes tokenizing the file's remaining literals
    (`dialogOverlayStyle`'s padding, `dialogHeaderStyle`'s gap, `dialogBoxStyle`'s `calc()` max-height,
    `toastStyle`'s bottom offset, `toastDismissButtonStyle`'s font size) and `text-style.ts`'s
    `textListStyle`/`textCodeStyle` padding — both renderers' own call sites already resolve `theme`/`sizing`
    once per render, so this is a pure signature change for them.
  - New token `color.scrim` (`@kohaku-ui/spec-core`'s `KnownThemeTokens`): the dialog backdrop color, now
    themeable instead of a hard-coded `rgba(17, 24, 39, 0.45)` (dark theme gets its own heavier value). Like
    `color.danger` / `color.focus` / `chart.palette`, it is excluded from the L2 generation vocabulary (the
    sandbox never renders a dialog), so this does not change `designSystemPromptFragment`'s output or
    `PROMPT_REVISION`.
  
  `@kohaku-ui/renderer-react`:
  
  - `RendererContextValue.renderSandbox` gains a 3rd parameter: `(node, spec, theme) => ReactNode`.
    `SpecView` now calls it with the provider's own `theme` (the same value `useRenderer().theme` /
    `useToken`/`useSizing` already read), so a host no longer needs to thread `theme` through its own
    closure to keep `SandboxFrame` in sync with the surface's theme — it can read the 3rd argument instead.
    Fully additive for an existing 2-argument implementation (still type-checks and runs unchanged, the
    extra argument is simply ignored); the sample app (`apps/sample-web`) and the React/WC parity harness
    have been migrated to the new argument, dropping their own manual `theme` closures.

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`0e47898`](https://github.com/yosuque/kohaku/commit/0e478989d5f34980498d27cc95dfae40f8f4868b) Thanks [@yosuque](https://github.com/yosuque)! - Implement `presentSpreadsheet`'s already-declared `sortChange` and `cellEdit` events and `editable` prop in both renderers: a user sort toggle can now emit `sortChange` (`{ value: { field, dir } }`), and `editable: true` turns idle cells into edit-trigger buttons that swap to a text input, coercing the typed value by column type and delivering a changed, valid edit via `cellEdit` (`{ row, value: { column, value, previousValue, rowIndex } }`) over the invoke path — with an optimistic local display that a fresh fetch discards automatically. Also cap `presentSpreadsheet`'s local (non-serverSide) row rendering at 500 rows and make the truncation footer honest when the source reports no `total`.
- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39), [`0e47898`](https://github.com/yosuque/kohaku/commit/0e478989d5f34980498d27cc95dfae40f8f4868b), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/renderer-core@0.2.0
  - @kohaku-ui/data-binding@0.2.0
  - @kohaku-ui/registry@0.2.0
