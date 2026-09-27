/**
 * Ambient, file-local typing for `process` (renderer-core has no @types/node dependency — it stays
 * environment-neutral, consumed by both a Node build step and a browser bundle). Deliberately written as a
 * direct `process.env.NODE_ENV` member-access chain below, not indirected through a `globalThis` cast (the
 * technique spec-core's canonical-json.ts uses for the same "no @types/node" constraint): a bundler's static
 * define (Vite / webpack both replace the literal `process.env.NODE_ENV` expression at build time, the same
 * mechanism React itself relies on) only fires on that exact syntactic shape, so going through an indirection
 * would silently defeat it and this check would never see "production" in a bundled build.
 */
declare const process: { env?: { NODE_ENV?: string } } | undefined;

/**
 * Best-effort development-mode check, shared by renderer-react's `implement` and renderer-wc's `implementWc`
 * to decide, by default, whether a schema mismatch between a node's props and its
 * `ComponentDefinition.propsSchema` is reported via `console.warn` at render time (design.md #68). This
 * gates only that diagnostic, never whether the props get parsed: `implement`/`implementWc` always run
 * `propsSchema.safeParse` so a `.default()`-ed value the Spec omits is materialized in every environment,
 * including a `NODE_ENV=production` build where this function returns `false`. Deliberately not based on a
 * bundler-specific global (`import.meta.env.DEV`, etc.) so the same check works unmodified in both
 * renderers' build pipelines; callers can always override the default via an explicit option instead of
 * relying on this.
 *
 * `typeof process === "undefined"` is the standard safe existence check (unlike `process !== undefined`,
 * `typeof` never throws on an identifier that was never declared as a global in the current environment), so
 * this is also safe to evaluate in a raw browser with no bundler define step at all — it then falls back to
 * "development" (the warning stays on), the conservative side to err on for a diagnostic-only check. The
 * same applies to a bare esbuild build invoked without `--define:process.env.NODE_ENV='"production"'` (e.g.
 * a plain `tsx`/`vite build` config that never sets `mode: "production"`): the literal
 * `process.env.NODE_ENV` expression above is never rewritten, so this still falls through to "development"
 * there too. This mirrors React's own bundled builds, which gate their development-only warnings on this
 * exact `process.env.NODE_ENV !== "production"` pattern. It costs nothing beyond an extra `console.warn`
 * call on the rare schema-mismatch path if left on by mistake — never a behavior difference, since parsing
 * itself is unconditional — but a host that wants the warning silenced in its own production build without
 * relying on a bundler's define should pass the explicit `{ validate: false }` option instead (see
 * `implement`'s and `implementWc`'s doc comments, and docs/user-guide.md's "Adding a part").
 */
export function isDevEnvironment(): boolean {
  return typeof process === "undefined" || process.env?.NODE_ENV !== "production";
}
