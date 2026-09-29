---
"@kohaku-ui/renderer-core": patch
"@kohaku-ui/renderer-react": patch
"@kohaku-ui/renderer-wc": patch
---

`action.button` and `presentForm` now show the governed-action phases that stop an action before it commits: a rejected payload (`invalid`, `role="alert"`) and a declined confirmation or pending approval (`awaitingApproval`, `role="status"`). renderer-core adds `actionPhaseNotice` and the `RendererMessages.actionInvalid` / `actionAwaiting` strings (design.md decisions 62-64); `<kohaku-surface>` also clears a form's previous submit message when a new submit starts, as the React form does.
