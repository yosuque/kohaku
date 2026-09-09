/**
 * The allowlist of window.kohaku bridge APIs that L2-generated HTML may use (single source of truth).
 * The hallucinated-API detector for L2-generated HTML (collectL2Issues) references it, and the drift
 * check against the surface the sandbox runtime actually exposes also imports and cross-checks it
 * from downstream packages.
 *
 * This single constant is carved out into its own module for dependency-direction reasons: sandbox is
 * downstream of composer, so adding a devDependency on composer for the drift check is the correct
 * direction, but importing via composer's barrel (index.ts) would pull sources with node dependencies
 * such as compose → llm into type resolution and break the typecheck of the node-independent sandbox.
 * This module, which has no imports, is exposed under the `@kohaku-ui/composer/l2-api` subpath so that
 * downstream can take in just this.
 */
export const KOHAKU_API_ALLOWLIST: ReadonlySet<string> = new Set(["fetchData", "emit", "onProps", "ready"]);
