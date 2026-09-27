// Kohaku DevTools ("why did this view come out this way"): a `kohaku explain <requestId>`-shaped console
// panel. Published as its own `@kohaku-ui/admin-react/devtools` subpath, decoupled from AdminProvider /
// KohakuAdmin, so a product can embed it standalone without pulling in the full governance console. Same
// dependency boundary as the package root (client / renderer-core / sandbox / spec-core only; never
// renderer-react -- see test/boundary.test.ts).

export { type DevToolsCapture, type RecentRequest, withDevToolsCapture } from "./capture.js";
export { KohakuDevTools, type KohakuDevToolsProps } from "./KohakuDevTools.js";
export { type DevToolsMessages, defaultDevToolsMessages } from "./messages.js";
