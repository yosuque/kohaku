import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as adminReactRoot from "../src/index.js";

// The 11 generic, domain-free UI primitives that live only on the `@kohaku-ui/admin-react/ui` subpath.
// `NoticeKind` / `NotifyFn` stay on the root (they type AdminProvider's `onNotice` prop) and are deliberately
// excluded from this list. `TIER_COLOR` and `describeDeniedOperation` (née `deniedMessage`) are domain
// vocabulary — RBAC / session semantics and generation-tier identity, not presentation primitives — so they
// live at the package root (`rbac.ts` / `tiers.ts`), not here: see DOMAIN_HELPERS_NOT_ON_UI below.
const RELOCATED_UI_PRIMITIVES = [
  "card",
  "Field",
  "Empty",
  "smallButton",
  "StatCard",
  "StatusBadge",
  "BarRow",
  "sectionTitle",
  "selectStyle",
  "TextAreaField",
  "ErrorBanner",
] as const;

// The domain helpers that were previously (and, per the review, wrongly) reachable only through the generic
// `/ui` subpath — sample-web imported them from there, contradicting the README's "ordinary KohakuAdmin usage
// never needs /ui" claim. They now live at the package root instead.
const DOMAIN_HELPERS_NOT_ON_UI = ["TIER_COLOR", "describeDeniedOperation"] as const;

// The ticket's dependency contract: client + renderer-core (+ sandbox for the promotion preview, spec-core for
// the shared types) → admin-react. Never renderer-react (the console is not a Spec renderer) and never
// host-rest (the console talks to the host only through the typed client). tsc already refuses an import of an
// undeclared workspace package, this test additionally pins the manifest so a stray `pnpm add` is caught too.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set([
  "@kohaku-ui/client",
  "@kohaku-ui/renderer-core",
  "@kohaku-ui/sandbox",
  "@kohaku-ui/spec-core",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("dependency boundary", () => {
  it("declares only the allowed @kohaku-ui dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const kohakuDeps = Object.keys(manifest.dependencies ?? {}).filter((d) => d.startsWith("@kohaku-ui/"));
    expect(kohakuDeps.sort()).toEqual([...ALLOWED].sort());
  });

  it("imports only the allowed @kohaku-ui packages from src", () => {
    const offenders: string[] = [];
    for (const file of walk(join(PKG_ROOT, "src"))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from\s+"(@kohaku-ui\/[a-z-]+)(?:\/[a-z-]+)?"/g)) {
        if (!ALLOWED.has(m[1]!)) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // FixationsClient.remove() is `@deprecated` in packages/client/src/client.ts (an alias that just forwards to
  // unfixate()), but a JSDoc tag does not fail a build, and the two methods hit the identical wire call, so no
  // behavioral test can catch a regression back to the deprecated name. This is the only guard against it.
  it("never calls the deprecated FixationsClient.remove() alias", () => {
    const offenders: string[] = [];
    for (const file of walk(join(PKG_ROOT, "src"))) {
      const src = readFileSync(file, "utf8");
      if (/\bfixations\s*\.\s*remove\s*\(/.test(src)) offenders.push(file);
    }
    expect(offenders, "use client.fixations.unfixate(...) instead of the deprecated remove() alias").toEqual(
      [],
    );
  });

  // The root keeps the domain API only; the 11 generic UI primitives are reachable solely through the
  // `@kohaku-ui/admin-react/ui` subpath. This asserts against the actual exported bindings (not a hardcoded
  // snapshot of "what index.ts currently looks like"), so it fails the moment any of the 11 names comes back
  // onto the root, whatever mechanism reintroduces it (a re-export, a new declaration, etc).
  it("does not export the relocated UI primitives from the root", () => {
    const rootExportNames = new Set(Object.keys(adminReactRoot));
    const leaked = RELOCATED_UI_PRIMITIVES.filter((name) => rootExportNames.has(name));
    expect(leaked).toEqual([]);
  });

  it("exposes all relocated UI primitives from the @kohaku-ui/admin-react/ui subpath", async () => {
    const ui: Record<string, unknown> = await import("@kohaku-ui/admin-react/ui");
    const missing = RELOCATED_UI_PRIMITIVES.filter((name) => !(name in ui));
    expect(missing).toEqual([]);
  });

  // The mirror-image guard for DOMAIN_HELPERS_NOT_ON_UI: they must be reachable from the root (the domain API)
  // and must NOT be reachable from the generic `/ui` subpath, closing the finding that sample-web had to import
  // `deniedMessage` / (the tier colors) from `/ui` for ordinary KohakuAdmin usage.
  it("exports the domain rbac/tier helpers from the root, not from the /ui subpath", async () => {
    const rootExportNames = new Set(Object.keys(adminReactRoot));
    const missingFromRoot = DOMAIN_HELPERS_NOT_ON_UI.filter((name) => !rootExportNames.has(name));
    expect(missingFromRoot).toEqual([]);

    const ui: Record<string, unknown> = await import("@kohaku-ui/admin-react/ui");
    const leakedIntoUi = DOMAIN_HELPERS_NOT_ON_UI.filter((name) => name in ui);
    expect(leakedIntoUi).toEqual([]);
  });
});
