import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMirrorSources, planMirror, routeOf } from "../src/mirror.js";
import { SIDEBAR_EN, SIDEBAR_JA, sidebarLinks } from "../src/sidebar.js";

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
    const dangling = [...sidebarLinks(SIDEBAR_EN), ...sidebarLinks(SIDEBAR_JA)].filter((l) => !routes.has(l));
    expect(dangling).toEqual([]);
  });

  it("keeps the EN and JA sidebars structurally parallel where a JA page exists", () => {
    const ja = sidebarLinks(SIDEBAR_JA).map((l) => l.replace(/^\/ja/, ""));
    for (const link of ja) expect(sidebarLinks(SIDEBAR_EN)).toContain(link);
  });
});
