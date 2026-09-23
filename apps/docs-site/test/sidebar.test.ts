import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMirrorSources, planMirror, routeOf } from "../src/mirror.js";
import { NAV_EN, NAV_JA, SIDEBAR_EN, SIDEBAR_JA, sidebarLinks } from "../src/sidebar.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("sidebar", () => {
  const pages = planMirror(listMirrorSources(REPO_ROOT)).filter((e) => e.kind === "page");
  const routes = new Set(pages.map(routeOf));

  it("lists every mirrored page exactly once (a page added to docs/ must get a sidebar entry)", () => {
    const listed = [...sidebarLinks(SIDEBAR_EN), ...sidebarLinks(SIDEBAR_JA)];
    expect(new Set(listed).size).toBe(listed.length);
    const missing = [...routes].filter((r) => !listed.includes(r));
    expect(missing).toEqual([]);
  });

  it("only links to pages that exist", () => {
    const navLinks = [...NAV_EN, ...NAV_JA].map((i) => i.link);
    const dangling = [...sidebarLinks(SIDEBAR_EN), ...sidebarLinks(SIDEBAR_JA), ...navLinks].filter(
      (l) => !routes.has(l),
    );
    expect(dangling).toEqual([]);
  });

  it("every Japanese sidebar link lives under /ja/ (a plain English link here would silently defeat the parallelism check below)", () => {
    for (const link of sidebarLinks(SIDEBAR_JA)) expect(link).toMatch(/^\/ja\//);
  });

  it("keeps the EN and JA sidebars structurally parallel where a JA page exists", () => {
    const ja = sidebarLinks(SIDEBAR_JA).map((l) => l.replace(/^\/ja\//, "/"));
    for (const link of ja) expect(sidebarLinks(SIDEBAR_EN)).toContain(link);
  });
});
