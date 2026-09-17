/**
 * Vitest setupFiles entry: pre-warms the sandbox smoke helper's dynamic `jsdom` import before any test
 * runs. `createL2Smoke`'s validator (packages/sandbox/src/smoke/index.ts) lazily `import()`s jsdom /
 * node:vm on its first call, and that first-import cost can exceed vitest's default per-test timeout
 * when the whole suite runs in parallel under load (see smoke-l2.test.ts's own timeout comment). Paying
 * that cost once here, before any individual test's clock starts, keeps testTimeout at the existing 20s
 * instead of having to raise it for every test in this project.
 */
import { createL2Smoke } from "@kohaku-ui/sandbox/smoke";

const WARMUP_HTML = "<!DOCTYPE html><html><body><script>window.kohaku.ready();</script></body></html>";

const warmup = createL2Smoke({ readyTimeoutMs: 200 });
await warmup(WARMUP_HTML, {});
