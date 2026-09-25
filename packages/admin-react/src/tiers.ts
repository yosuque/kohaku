/**
 * Tier accents (L0 fixed / L1 declarative / L2 free): kept as literals because they are semantic (which
 * generation tier produced a part), not themed — a product's ThemeTokens has no opinion on tier identity, so
 * these do not follow `--kohaku-color-*` the way `theme.ts`'s `V` palette does. Domain vocabulary of the
 * console (like `describeDeniedOperation` in `rbac.ts`), so it lives at the package root, not on the generic
 * `/ui` primitives subpath.
 */
export const TIER_COLOR: Record<string, string> = { L0: "#1e40af", L1: "#166534", L2: "#c2410c" };
