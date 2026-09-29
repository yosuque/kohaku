import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { forbidNodeBuiltins } from "./vite/forbid-node-builtins.js";

// KOHAKU_PLAYGROUND_AUDIT=1 switches the plugin from "stop at the first Node-only import" (the default,
// the right behavior for an actual production build) to "collect every one and print the full list at the
// end of the build" (the audit mode behind design.md decision 57's Node-free playground build). Read here rather than requiring a raw `VAR=1 …` shell prefix at
// the call site: the audit run goes through package.json's `build:audit` script instead, so it stays inside
// the plain `pnpm --filter <pkg> run <script>` command shape.
const auditMode = process.env["KOHAKU_PLAYGROUND_AUDIT"] === "1";

export default defineConfig({
  plugins: [react(), forbidNodeBuiltins({ mode: auditMode ? "audit" : "strict" })],
});
